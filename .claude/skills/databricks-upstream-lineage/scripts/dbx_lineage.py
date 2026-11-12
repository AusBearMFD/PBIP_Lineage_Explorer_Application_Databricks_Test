#!/usr/bin/env python3
"""
dbx_lineage.py - read-only Databricks lookups for tracing a Power BI source table upstream.

Uses the Databricks CLI (already signed in with a profile), so no token is handled here.

  python dbx_lineage.py whoami
  python dbx_lineage.py table   <catalog.schema.table>        # type, view SQL, recent writes and the jobs behind them
  python dbx_lineage.py lineage <catalog.schema.table>        # upstream tables: system table, else lineage API
  python dbx_lineage.py runs    <job_id> [--limit 10]         # recent runs and their results
  python dbx_lineage.py fresh   <catalog.schema.table>        # is the data current? last write + writer job's runs
  python dbx_lineage.py details <catalog.schema.table>        # what the app's details panel shows: SQL, writer job,
                                                              #   schedule (set or observed), recent runs, links
  python dbx_lineage.py sql     "<SELECT ...>"                # any read-only query

Options: --profile <name> (or DATABRICKS_CONFIG_PROFILE), --warehouse <id> (or DBX_WAREHOUSE_ID),
         --stale-hours <n> (default 30) for `fresh`.
Everything prints JSON. Exit codes: 0 ok, 2 bad arguments, 3 not signed in, 4 not found or no access.

Read-only by design: `sql` refuses anything but SELECT / SHOW / DESCRIBE / WITH.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

READ_ONLY = re.compile(r"^\s*(select|show|describe|desc|with|explain)\b", re.I)


class Fail(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


def parse_args(argv):
    opts = {"profile": os.environ.get("DATABRICKS_CONFIG_PROFILE", "genie"),
            "warehouse": os.environ.get("DBX_WAREHOUSE_ID"), "limit": 10, "stale_hours": 30}
    pos = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--profile", "--warehouse", "--limit", "--stale-hours"):
            if i + 1 >= len(argv):
                raise Fail(f"{a} needs a value", 2)
            key = a[2:].replace("-", "_")
            opts[key] = argv[i + 1] if key in ("profile", "warehouse") else int(argv[i + 1])
            i += 2
            continue
        pos.append(a)
        i += 1
    if not pos:
        raise Fail(__doc__, 2)
    opts["cmd"], opts["args"] = pos[0], pos[1:]
    return opts


def cli(opts, *args, body=None):
    exe = shutil.which("databricks")
    if not exe:
        raise Fail("The Databricks CLI isn't installed or isn't on PATH.", 3)
    cmd = [exe, "--profile", opts["profile"], *args, "--output", "json"]
    env = {**os.environ, "MSYS_NO_PATHCONV": "1"}  # keep /api/... paths intact in Git Bash
    p = subprocess.run(cmd, input=json.dumps(body) if body is not None else None,
                       capture_output=True, text=True, env=env, timeout=300)
    if p.returncode != 0:
        err = (p.stderr or p.stdout).strip()
        if re.search(r"auth|token|login|401|403|unauthenticated", err, re.I) and "PERMISSION_DENIED" not in err:
            raise Fail(f"Not signed in to Databricks profile '{opts['profile']}'. Run: databricks auth login --profile {opts['profile']}\n{err[-400:]}", 3)
        if re.search(r"NOT_FOUND|does not exist|PERMISSION_DENIED|not authorized|INSUFFICIENT", err, re.I):
            raise Fail(err[-600:], 4)
        raise Fail(err[-600:])
    return json.loads(p.stdout) if p.stdout.strip() else {}


def sql(opts, statement):
    if not READ_ONLY.match(statement):
        raise Fail("Only read-only statements (SELECT, SHOW, DESCRIBE, WITH, EXPLAIN) are allowed.", 2)
    if not opts.get("warehouse"):
        raise Fail("Pass --warehouse <id> or set DBX_WAREHOUSE_ID (a SQL warehouse you can use).", 2)
    body = {"statement": statement, "warehouse_id": opts["warehouse"], "wait_timeout": "50s",
            "on_wait_timeout": "CONTINUE", "format": "JSON_ARRAY", "disposition": "INLINE"}
    res = cli(opts, "api", "post", "/api/2.0/sql/statements", "--json", json.dumps(body))
    sid = res.get("statement_id")
    while res.get("status", {}).get("state") in ("PENDING", "RUNNING"):
        time.sleep(2)
        res = cli(opts, "api", "get", f"/api/2.0/sql/statements/{sid}")
    state = res.get("status", {}).get("state")
    if state != "SUCCEEDED":
        msg = res.get("status", {}).get("error", {}).get("message", state)
        code = 4 if re.search(r"TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|PERMISSION|INSUFFICIENT|not authorized", msg or "", re.I) else 1
        raise Fail(f"Query failed: {msg}", code)
    cols = [c["name"] for c in res.get("manifest", {}).get("schema", {}).get("columns", [])]
    rows = res.get("result", {}).get("data_array", []) or []
    return [dict(zip(cols, r)) for r in rows]


def q(name):
    """Backtick each part of catalog.schema.table (catalogs like facilities-prod need it)."""
    return ".".join(f"`{p.strip('`')}`" for p in name.split("."))


def table_info(opts, fqn):
    out = {"table": fqn}
    detail = sql(opts, f"DESCRIBE TABLE EXTENDED {q(fqn)}")
    meta = {r.get("col_name", "").strip(): (r.get("data_type") or "").strip() for r in detail}
    out["type"] = meta.get("Type", "")
    out["owner"] = meta.get("Owner", "")
    out["location"] = meta.get("Location", "")
    # Columns come first; a blank row or a "# ..." heading starts the partition/detail sections.
    out["columns"] = []
    for r in detail:
        name = (r.get("col_name") or "").strip()
        if not name or name.startswith("#"):
            break
        out["columns"].append(name)
    out["columns"] = out["columns"][:200]
    if "VIEW" in out["type"].upper():
        view = meta.get("View Text") or ""
        if not view:
            try:
                view = sql(opts, f"SHOW CREATE TABLE {q(fqn)}")[0].get("createtab_stmt", "")
            except Fail:
                view = ""
        out["viewSql"] = view
        out["viewReads"] = tables_in_sql(view)
    else:
        out["recentWrites"] = writes(opts, fqn)
    return out


def writes(opts, fqn, limit=15):
    try:
        rows = sql(opts, f"DESCRIBE HISTORY {q(fqn)} LIMIT {int(limit)}")
    except Fail as e:
        return {"error": str(e)}
    out = []
    for r in rows:
        job = r.get("job")
        if isinstance(job, str) and job.startswith("{"):
            try:
                job = json.loads(job)
            except ValueError:
                pass
        nb = r.get("notebook")
        if isinstance(nb, str) and nb.startswith("{"):
            try:
                nb = json.loads(nb)
            except ValueError:
                pass
        out.append({
            "version": r.get("version"), "timestamp": r.get("timestamp"), "operation": r.get("operation"),
            "user": r.get("userName"),
            "jobId": (job or {}).get("jobId") if isinstance(job, dict) else None,
            "jobName": (job or {}).get("jobName") if isinstance(job, dict) else None,
            "runId": (job or {}).get("jobRunId") or (job or {}).get("runId") if isinstance(job, dict) else None,
            "notebookId": (nb or {}).get("notebookId") if isinstance(nb, dict) else None,
        })
    return out


TABLE_RE = re.compile(r"\b(?:FROM|JOIN)\s+((?:`[^`]+`|[A-Za-z_][\w-]*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_][\w-]*)){0,2})", re.I)


def tables_in_sql(text):
    if not text:
        return []
    clean = re.sub(r"--[^\n]*", " ", text)
    clean = re.sub(r"/\*.*?\*/", " ", clean, flags=re.S)
    clean = re.sub(r"'(?:[^']|'')*'", "''", clean)
    # Names defined in the statement's own WITH clause (CTEs) are steps, not tables.
    ctes = {m.group(1).lower() for m in re.finditer(r"(?:\bWITH\b|,)\s*`?([A-Za-z_][\w-]*)`?\s+AS\s*\(", clean, re.I)}
    seen = []
    for m in TABLE_RE.finditer(clean):
        name = re.sub(r"[`\s]", "", m.group(1))
        if name.lower() in ("select", "lateral", "values") or name in seen:
            continue
        if "." not in name and name.lower() in ctes:
            continue
        seen.append(name)
    return seen


def lineage(opts, fqn):
    """Upstream tables. Tries the lineage system table, then the lineage-tracking API."""
    result = {"table": fqn, "upstream": [], "evidence": None, "notes": []}
    try:
        rows = sql(opts, (
            "SELECT DISTINCT source_table_full_name, source_type, entity_type, entity_id, "
            "max(event_time) AS last_seen FROM system.access.table_lineage "
            f"WHERE target_table_full_name = '{fqn.replace('`', '')}' AND source_table_full_name IS NOT NULL "
            "GROUP BY ALL ORDER BY last_seen DESC LIMIT 200"))
        result["upstream"] = [{"table": r["source_table_full_name"], "sourceType": r.get("source_type"),
                               "via": f"{(r.get('entity_type') or '').lower()}:{r.get('entity_id')}" if r.get("entity_type") else "",
                               "lastSeen": r.get("last_seen")} for r in rows]
        result["evidence"] = "system.access.table_lineage"
        return result
    except Fail as e:
        result["notes"].append(f"system.access.table_lineage not readable: {str(e)[:200]}")
    try:
        res = cli(opts, "api", "get", "/api/2.0/lineage-tracking/table-lineage",
                  "--json", json.dumps({"table_name": fqn.replace("`", ""), "include_entity_lineage": True}))
        for u in res.get("upstreams", []) or []:
            t = u.get("tableInfo") or {}
            name = ".".join(x for x in (t.get("catalog_name"), t.get("schema_name"), t.get("name")) if x)
            jobs = sorted({f"job:{j.get('job_id')}" for j in (u.get("jobInfos") or []) if j.get("job_id")})
            notebooks = {n.get("notebook_id") for n in (u.get("notebookInfos") or []) if n.get("notebook_id")}
            via = ", ".join(jobs)
            if notebooks:
                via += f"{'; ' if via else ''}{len(notebooks)} notebook(s) also read it"
            if name:
                result["upstream"].append({"table": name, "sourceType": t.get("table_type"), "via": via,
                                           "jobIds": [j.split(":")[1] for j in jobs]})
        result["evidence"] = "Unity Catalog lineage API (/api/2.0/lineage-tracking/table-lineage)"
    except Fail as e:
        result["notes"].append(f"lineage API failed: {str(e)[:200]}")
    if not result["upstream"]:
        result["notes"].append("No recorded upstream. Next: `table` for view SQL and the jobs that write it, then read that job's code.")
    return result


def runs(opts, job_id, limit=10):
    res = cli(opts, "jobs", "list-runs", "--job-id", str(job_id), "--limit", str(limit))
    items = res if isinstance(res, list) else res.get("runs", [])
    out = []
    for r in items:
        st = r.get("state", {})
        out.append({
            "runId": r.get("run_id"),
            "start": iso(r.get("start_time")), "end": iso(r.get("end_time")),
            "lifeCycle": st.get("life_cycle_state"), "result": st.get("result_state"),
            "message": (st.get("state_message") or "")[:300],
            "url": r.get("run_page_url"),
        })
    name, visible, note = None, True, ""
    try:
        name = cli(opts, "jobs", "get", str(job_id)).get("settings", {}).get("name")
    except Fail as e:
        # list-runs returns an empty list for a job you can't view; `jobs get` says why.
        if re.search(r"permission|not authorized|does not have", str(e), re.I):
            visible, note = False, "You don't have View permission on this job; ask its owner or check in the Jobs UI."
        elif re.search(r"does not exist|not found|RESOURCE_DOES_NOT_EXIST", str(e), re.I):
            visible, note = False, "Job no longer exists (deleted or recreated under a new id)."
    return {"jobId": job_id, "jobName": name, "visible": visible, "note": note, "runs": out}


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat() if ms else None


def fresh(opts, fqn):
    """ok | stale | failed, with the evidence: last write, writer job, its latest runs."""
    hist = writes(opts, fqn, limit=30)
    if isinstance(hist, dict):
        if "EXPECT_TABLE_NOT_VIEW" in hist["error"]:
            return {"table": fqn, "status": "view", "message": "A view has no write history; it is as current as "
                    "the tables it reads, so check those with `fresh`."}
        return {"table": fqn, "status": "unknown", "message": hist["error"]}
    data_writes = [h for h in hist if (h.get("operation") or "").upper() in
                   ("WRITE", "MERGE", "CREATE OR REPLACE TABLE AS SELECT", "REPLACE TABLE AS SELECT",
                    "CREATE TABLE AS SELECT", "STREAMING UPDATE", "UPDATE", "DELETE", "TRUNCATE", "COPY INTO")]
    last = (data_writes or hist or [None])[0]
    out = {"table": fqn, "lastWrite": last and last.get("timestamp"), "lastOperation": last and last.get("operation"),
           "writerJob": last and (last.get("jobName") or last.get("jobId"))}
    age_h = None
    if last and last.get("timestamp"):
        try:
            ts = datetime.fromisoformat(str(last["timestamp"]).replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            age_h = round((datetime.now(timezone.utc) - ts).total_seconds() / 3600, 1)
        except ValueError:
            pass
    out["hoursSinceWrite"] = age_h
    status, msg = "ok", ""
    job_id = last and last.get("jobId")
    if job_id:
        try:
            r = runs(opts, job_id, limit=5)
            out["writerJobRuns"] = r["runs"]
            out["writerJob"] = r.get("jobName") or out["writerJob"] or job_id
            if not r["visible"]:
                out["writerJobNote"] = r["note"] + " Freshness is judged from the last write time only." 
            finished = [x for x in r["runs"] if x.get("result")]
            if finished and finished[0]["result"] not in ("SUCCESS", None):
                fails = 0
                for x in finished:
                    if x["result"] == "SUCCESS":
                        break
                    fails += 1
                status, msg = "failed", f"last {fails} run(s) of {out['writerJob']} ended {finished[0]['result']}: {finished[0]['message']}"
        except Fail as e:
            out["writerJobRuns"] = {"error": str(e)[:200]}
    if status == "ok" and age_h is not None and age_h > opts["stale_hours"]:
        status, msg = "stale", f"no write for {age_h} hours (threshold {opts['stale_hours']})"
    out["status"], out["message"] = status, msg
    return out


DATA_OPS = ("WRITE", "MERGE", "CREATE OR REPLACE TABLE AS SELECT", "REPLACE TABLE AS SELECT",
            "CREATE TABLE AS SELECT", "STREAMING UPDATE", "UPDATE", "DELETE", "TRUNCATE", "COPY INTO")
_HOST = {}


def host(opts):
    """Workspace URL for links (from the CLI profile; no token involved)."""
    if opts["profile"] not in _HOST:
        try:
            d = cli(opts, "auth", "describe")
            _HOST[opts["profile"]] = ((d.get("details") or {}).get("host") or d.get("host") or "").rstrip("/")
        except Fail:
            _HOST[opts["profile"]] = ""
    return _HOST[opts["profile"]]


def _json(v):
    if isinstance(v, str) and v[:1] in "{[":
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def history(opts, fqn, limit=100):
    """DESCRIBE HISTORY with the fields the details panel needs."""
    rows = sql(opts, f"DESCRIBE HISTORY {q(fqn)} LIMIT {int(limit)}")
    out = []
    for r in rows:
        job = _json(r.get("job"))
        job = job if isinstance(job, dict) else {}
        params = _json(r.get("operationParameters"))
        metrics = _json(r.get("operationMetrics"))
        metrics = metrics if isinstance(metrics, dict) else {}
        rows_written = None
        for k in ("numOutputRows", "numTargetRowsInserted", "numCopiedRows"):
            if metrics.get(k) not in (None, ""):
                try:
                    rows_written = (rows_written or 0) + int(metrics[k])
                except ValueError:
                    pass
        out.append({
            "time": r.get("timestamp"), "operation": r.get("operation"),
            "mode": (params or {}).get("mode") if isinstance(params, dict) else None,
            "user": r.get("userName"), "jobId": job.get("jobId"), "jobName": job.get("jobName"),
            "jobRunId": job.get("jobRunId") or job.get("runId"), "trigger": job.get("triggerType"),
            "rows": rows_written, "statementId": r.get("queryHistoryStatementId"),
        })
    return out


def _ts(s):
    try:
        t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _every(hours):
    if hours < 1.5:
        return f"about every {max(1, round(hours * 60))} minutes"
    if hours < 20:
        return f"about every {round(hours)} hours"
    if hours < 30:
        return "about once a day"
    if 150 < hours < 190:
        return "about once a week"
    return f"about every {round(hours / 24)} days"


def activity(hist):
    """Group history into runs (one per job run, or per person per 10 minutes) and
    read a schedule from their timing. Only committed writes are in Delta history."""
    groups = []
    for h in hist:
        t = _ts(h["time"])
        if not t:
            continue
        key = h.get("jobRunId") or None
        g = next((g for g in groups if (key and g["runId"] == key) or
                  (not key and not g["runId"] and g["user"] == h.get("user") and abs((g["t"] - t).total_seconds()) < 600)), None)
        if not g:
            g = {"runId": key, "jobId": h.get("jobId"), "jobName": h.get("jobName"), "user": h.get("user"),
                 "trigger": h.get("trigger"), "t": t, "ops": [], "rows": None}
            groups.append(g)
        g["t"] = max(g["t"], t)
        if h.get("operation") and h["operation"] not in g["ops"]:
            g["ops"].append(h["operation"])
        if h.get("rows") is not None:
            g["rows"] = (g["rows"] or 0) + h["rows"]
    data_runs = [g for g in groups if any(o.upper() in DATA_OPS for o in g["ops"])]
    data_runs.sort(key=lambda g: g["t"], reverse=True)
    runs_out = [{"time": g["t"].strftime("%Y-%m-%dT%H:%M:%SZ"), "status": "Succeeded",
                 "operation": " + ".join(g["ops"]), "rows": g["rows"], "runId": g["runId"],
                 "job": g["jobName"] or (str(g["jobId"]) if g["jobId"] else None),
                 "by": None if g["jobId"] else g["user"], "trigger": g["trigger"]}
                for g in data_runs]
    schedule = None
    times = [g["t"] for g in data_runs][:40]
    if len(times) >= 3:
        gaps = sorted((a - b).total_seconds() / 3600 for a, b in zip(times, times[1:]))
        med = gaps[len(gaps) // 2]
        summary = f"Writes {_every(med)}"
        if 20 <= med <= 30 or 150 < med < 190:
            mins = sorted(t.hour * 60 + t.minute for t in times[:15])
            m = mins[len(mins) // 2]
            summary += f", usually around {m // 60:02d}:{m % 60:02d} UTC"
        if 150 < med < 190:
            days = [t.strftime("%A") for t in times[:8]]
            summary += f" on {max(set(days), key=days.count)}"
        age = (datetime.now(timezone.utc) - times[0]).total_seconds() / 3600
        late = age > med * 1.5 + 2
        schedule = {"summary": summary, "intervalHours": round(med, 2), "source":
                    "observed from the table's Delta history (when its data was written), not the job's schedule setting",
                    "overdue": late, "hoursSinceLastWrite": round(age, 1)}
        if late:
            schedule["message"] = (f"No write for {round(age, 1)} hours, longer than the usual gap of {round(med, 1)}: "
                                   "a run may have failed or been skipped.")
    elif times:
        schedule = {"summary": "Written only " + ("once" if len(times) == 1 else "twice") +
                    " in the history read, so no regular schedule shows",
                    "source": "observed from the table's Delta history"}
    return runs_out, schedule


def job_details(opts, job_id):
    """Schedule, tasks and recent runs of a job, when you can view it."""
    out = {"jobId": str(job_id), "visible": True}
    try:
        j = cli(opts, "jobs", "get", str(job_id))
    except Fail as e:
        msg = str(e)
        out["visible"] = False
        out["note"] = ("You don't have View permission on this job; its schedule setting, failed runs and code are "
                       "shown only to people who do." if re.search(r"permission|not authorized|does not have", msg, re.I)
                       else "The job no longer exists (deleted, or recreated under a new id)."
                       if re.search(r"does not exist|not found", msg, re.I) else msg[:200])
        return out
    s = j.get("settings", {})
    out["jobName"] = s.get("name")
    out["runAs"] = j.get("run_as_user_name") or j.get("creator_user_name")
    sch = s.get("schedule") or {}
    trig = s.get("trigger") or {}
    if sch:
        paused = sch.get("pause_status") == "PAUSED"
        out["schedule"] = {"cron": sch.get("quartz_cron_expression"), "timezone": sch.get("timezone_id"), "paused": paused,
                           "summary": f"Scheduled: {sch.get('quartz_cron_expression')} ({sch.get('timezone_id')})"
                                      + (" — paused" if paused else ""),
                           "source": "the job's schedule setting"}
    elif trig:
        kind = ("file arrival" if trig.get("file_arrival") else "table update" if trig.get("table_update")
                else "periodic" if trig.get("periodic") else "a trigger")
        out["schedule"] = {"summary": f"Runs on {kind}" + (" — paused" if trig.get("pause_status") == "PAUSED" else ""),
                           "paused": trig.get("pause_status") == "PAUSED", "source": "the job's trigger setting"}
    elif s.get("continuous"):
        out["schedule"] = {"summary": "Runs continuously", "source": "the job's settings"}
    else:
        out["schedule"] = {"summary": "No schedule: runs only when started by hand or by another job",
                           "source": "the job's settings"}
    tasks = []
    for t in s.get("tasks", []) or []:
        kind = next((k for k in t if k.endswith("_task")), "")
        body = t.get(kind) or {}
        target = (body.get("notebook_path") or body.get("python_file") or (body.get("file") or {}).get("path")
                  or (body.get("query") or {}).get("query_id") or body.get("pipeline_id") or body.get("job_id") or "")
        tasks.append({"key": t.get("task_key"), "type": kind.replace("_task", ""), "target": str(target),
                      "source": body.get("source")})
    out["tasks"] = tasks
    try:
        out["runs"] = runs(opts, job_id, limit=10)["runs"]
    except Fail as e:
        out["runsError"] = str(e)[:200]
    return out


def writer_code(opts, job, fqn, max_chars=6000):
    """Code that writes the table, from a viewable job: the SQL of a SQL task, or the
    notebook cells that name the table. Best effort; returns None when not readable."""
    name = fqn.split(".")[-1].lower()
    for t in job.get("tasks") or []:
        try:
            if t["type"] == "sql" and t["target"] and not t["target"].startswith("/"):
                qd = cli(opts, "api", "get", f"/api/2.0/sql/queries/{t['target']}")
                text = qd.get("query_text") or qd.get("query") or ""
                if text:
                    return {"text": text[:max_chars], "source": f"SQL task {t['key']} (query {t['target']})"}
            if t["type"] in ("notebook", "spark_python", "sql") and t["target"].startswith("/") and t.get("source") != "GIT":
                exe = shutil.which("databricks")
                p = subprocess.run([exe, "--profile", opts["profile"], "workspace", "export", t["target"], "--format", "SOURCE"],
                                   capture_output=True, text=True, env={**os.environ, "MSYS_NO_PATHCONV": "1"}, timeout=120)
                if p.returncode != 0:
                    continue
                cells = re.split(r"\n# COMMAND -+\n|\n-- COMMAND -+\n", p.stdout)
                hits = [c.strip() for c in cells if name in c.lower()]
                if hits:
                    return {"text": "\n\n-- …\n\n".join(hits)[:max_chars],
                            "source": f"cells of {t['target']} that name {name} (task {t['key']})"}
        except (Fail, OSError, subprocess.SubprocessError):
            continue
    return None


def details(opts, fqn, ti=None):
    """Everything the app's table details panel shows for a Databricks table or view."""
    ti = ti or table_info(opts, fqn)
    base = host(opts)
    parts = fqn.replace("`", "").split(".")
    d = {"columns": ti.get("columns") or []}
    links = []
    if base and len(parts) == 3:
        links.append({"label": "Open in Catalog Explorer", "url": f"{base}/explore/data/{'/'.join(parts)}"})
    if "VIEW" in (ti.get("type") or "").upper():
        if ti.get("viewSql"):
            d["sql"], d["sqlSource"] = ti["viewSql"], "view definition (Unity Catalog)"
        d["schedule"] = {"summary": "A view runs its SQL each time it's read, so it's as current as the tables it reads.",
                         "source": "view"}
        d["links"] = links
        return d
    try:
        hist = history(opts, fqn)
    except Fail as e:
        d["historyError"] = str(e)[:300]
        d["links"] = links
        return d
    run_list, schedule = activity(hist)
    d["runs"] = run_list[:12]
    d["runsSource"] = ("the table's Delta history: each row is a committed write, so failed or skipped runs don't "
                       "appear here; the job's own run history shows those")
    if schedule:
        d["schedule"] = schedule
    writer_id = next((h["jobId"] for h in hist if h.get("jobId") and (h.get("operation") or "").upper() in DATA_OPS), None)
    last = next((r for r in run_list if writer_id and r.get("job")), None) or (run_list[0] if run_list else None)
    if writer_id:
        job = job_details(opts, writer_id)
        hist_name = next((h["jobName"] for h in hist if h.get("jobId") == writer_id and h.get("jobName")), None)
        d["writer"] = {"jobId": str(writer_id), "jobName": job.get("jobName") or hist_name,
                       "runAs": job.get("runAs") or next((h["user"] for h in hist if h.get("jobId") == writer_id), None),
                       "operation": last and last.get("operation"), "visible": job["visible"], "note": job.get("note", "")}
        if job.get("tasks"):
            d["writer"]["tasks"] = job["tasks"]
        # Some tables are written by more than one job (e.g. an hourly and a nightly load).
        counts = {}
        for r in run_list:
            if r.get("job") and r.get("runId"):
                counts[r["job"]] = counts.get(r["job"], 0) + 1
        if len(counts) > 1:
            d["writer"]["allJobs"] = [{"job": k, "writes": v} for k, v in sorted(counts.items(), key=lambda kv: -kv[1])]
            d["writer"]["note"] = (f"Written by {len(counts)} jobs in the history read. " + d["writer"]["note"]).strip()
        if job.get("schedule"):
            obs = d.get("schedule")
            d["schedule"] = {**job["schedule"], **({"observed": obs["summary"]} if obs else {})}
        if job.get("runs"):
            d["runs"] = [{"time": r["start"], "status": (r.get("result") or r.get("lifeCycle") or "").title(),
                          "runId": r.get("runId"), "message": r.get("message"), "url": r.get("url")} for r in job["runs"]]
            d["runsSource"] = "the job's run history"
        if job["visible"]:
            code = writer_code(opts, job, fqn)
            if code:
                d["sql"], d["sqlSource"] = code["text"], code["source"]
        if base:
            links.append({"label": "Writing job in Databricks", "url": f"{base}/jobs/{writer_id}"})
            if last and last.get("runId"):
                links.append({"label": "Latest run that wrote it", "url": f"{base}/jobs/{writer_id}/runs/{last['runId']}"})
    elif last:
        d["writer"] = {"runAs": last.get("by"), "operation": last.get("operation"), "visible": True,
                       "note": "Written by a person (not a scheduled job), so it may be a one-time snapshot."}
    if not d.get("sql"):
        d["sqlNote"] = ("The SQL or code that writes this table isn't readable here: query history shows only your own "
                        "queries, and the writing job needs View permission. Ask the job's owner, or open the job link."
                        if writer_id else
                        "Created by a person with a SQL statement. It's in that person's query history, which only they "
                        "(or a workspace admin) can read; ask them for it." if last and last.get("by") else
                        "No SQL is recorded for this table.")
    d["links"] = links
    return d


def main():
    try:
        opts = parse_args(sys.argv[1:])
        cmd, args = opts["cmd"], opts["args"]
        need = lambda n: args[0] if args else (_ for _ in ()).throw(Fail(f"{cmd} needs {n}", 2))
        if cmd == "whoami":
            res = cli(opts, "current-user", "me")
            result = {"user": res.get("userName"), "profile": opts["profile"], "warehouse": opts.get("warehouse")}
        elif cmd == "table":
            result = table_info(opts, need("a table name"))
        elif cmd == "lineage":
            result = lineage(opts, need("a table name"))
        elif cmd == "runs":
            result = runs(opts, need("a job id"), opts["limit"])
        elif cmd == "fresh":
            result = fresh(opts, need("a table name"))
        elif cmd == "details":
            result = details(opts, need("a table name"))
        elif cmd == "sql":
            result = sql(opts, need("a statement"))
        else:
            raise Fail(f"Unknown command {cmd}\n{__doc__}", 2)
        print(json.dumps(result, indent=2, default=str))
    except Fail as e:
        print(str(e), file=sys.stderr)
        sys.exit(e.code)


if __name__ == "__main__":
    main()
