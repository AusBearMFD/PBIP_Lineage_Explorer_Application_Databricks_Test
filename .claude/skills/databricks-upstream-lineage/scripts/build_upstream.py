#!/usr/bin/env python3
"""
build_upstream.py - draft <pbip folder>/.lineage/upstream.json from recorded Databricks lineage.

  python build_upstream.py "<pbip folder>" [--out <file>] [--max-hops 8] [--workers 8]
                           [--cache <dir>] [--profile genie] [--warehouse <id>] [--stale-hours 30]

1. Lists the model's Databricks tables (pbip-lineage-analyst `lineage.mjs sources`). When
   the model reads Power BI dataflows, runs `dataflow_lineage.mjs collect` first: each
   dataflow table, the queries and linked tables it's built from, their Power Query and
   whether it's direct / shaped / transformed, refresh history; the Databricks tables the
   dataflows read join the trace. (Needs `az login`; skipped with a note otherwise.)
2. Walks each upstream with recorded lineage (system table, else the lineage API), up to
   --max-hops, and reads each table's type, writers and freshness (same calls as
   dbx_lineage.py `lineage`, `table`, `fresh`).
3. Reads each table's details for the app's details panel (dbx_lineage.py `details`):
   view SQL, the writing job(s), schedule (the job's setting when you can view the job,
   otherwise observed from when the table was written), recent writes or runs, columns
   and links into Databricks. --no-details skips this.
4. Writes version-1 upstream.json: every link is "recorded"; every trail end is a
   best-known stop with its reason. It never marks origins or inferred links. Those
   need a person (or the agent) to read job code and agree with reference/origins.md.

--cache <dir> keeps one JSON per table (lineage/table/fresh/details), so a re-run only
fetches tables it hasn't seen; delete the folder to refresh everything.
Read-only: it only runs the lookups dbx_lineage.py allows.
"""
import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dbx_lineage as dbx  # noqa: E402

LINEAGE_MJS = os.path.join(HERE, "..", "..", "pbip-lineage-analyst", "scripts", "lineage.mjs")
DATAFLOW_MJS = os.path.join(HERE, "dataflow_lineage.mjs")


def parse(argv):
    o = {"profile": os.environ.get("DATABRICKS_CONFIG_PROFILE", "genie"), "warehouse": os.environ.get("DBX_WAREHOUSE_ID"),
         "stale_hours": 30, "max_hops": 8, "workers": 8, "out": None, "cache": None, "limit": 10, "details": True}
    pos, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-details":
            o["details"] = False
            i += 1
        elif a.startswith("--") and i + 1 < len(argv):
            k = a[2:].replace("-", "_")
            o[k] = int(argv[i + 1]) if k in ("stale_hours", "max_hops", "workers") else argv[i + 1]
            i += 2
        else:
            pos.append(a)
            i += 1
    if not pos:
        sys.exit(__doc__)
    o["pbip"] = pos[0]
    o["out"] = o["out"] or os.path.join(o["pbip"], ".lineage", "upstream.json")
    if not o["warehouse"]:
        sys.exit("Pass --warehouse <id> or set DBX_WAREHOUSE_ID.")
    return o


def model_tables(pbip):
    p = subprocess.run(["node", LINEAGE_MJS, "sources", pbip], capture_output=True, text=True, encoding="utf-8")
    text = p.stdout
    if "{" not in text:
        sys.exit(f"lineage.mjs sources failed:\n{p.stderr or text}")
    return json.loads(text[text.index("{"):])


def dataflows(pbip):
    p = subprocess.run(["node", DATAFLOW_MJS, "collect", pbip], capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0 or "{" not in p.stdout:
        return None, (p.stderr or p.stdout).strip()[-400:]
    return json.loads(p.stdout[p.stdout.index("{"):]), None


def merge_dataflows(doc, df):
    low = lambda x: str(x).lower()
    have = {low(n["id"]) for n in doc["nodes"]}
    for n in df["nodes"]:
        if low(n["id"]) not in have:
            doc["nodes"].append(n)
            have.add(low(n["id"]))
    keys = {(low(e["from"]), low(e["to"])) for e in doc["edges"]}
    for e in df["edges"]:
        if (low(e["from"]), low(e["to"])) not in keys:
            doc["edges"].append(e)
            keys.add((low(e["from"]), low(e["to"])))
    stopped = {low(x["node"]) for x in doc["stops"]}
    traced = {low(n["id"]) for n in doc["nodes"] if n.get("details") and low(n["id"]).startswith("dbx:")}
    for x in df["stops"]:
        if low(x["node"]) not in stopped and low(x["node"]) not in traced:
            doc["stops"].append(x)


def lookup(o, t):
    def safe(fn):
        try:
            return fn(o, t)
        except dbx.Fail as e:
            return {"error": str(e)[:500]}
    r = {"lineage": safe(dbx.lineage), "table": safe(dbx.table_info), "fresh": safe(dbx.fresh)}
    if o.get("details"):
        add_details(o, t, r)
    return r


def add_details(o, t, r):
    ti = r["table"] if not r["table"].get("error") else None
    try:
        r["details"] = dbx.details(o, t, ti)
    except dbx.Fail as e:
        r["details"] = {"error": str(e)[:500]}


def crawl(o, seeds):
    data, depth, frontier = {}, {s: 0 for s in seeds}, list(seeds)
    cache = o.get("cache")
    if cache:
        os.makedirs(cache, exist_ok=True)

    def visit(t):
        f = cache and os.path.join(cache, t + ".json")
        if f and os.path.exists(f):
            r = json.load(open(f, encoding="utf-8"))
            if o.get("details") and "details" not in r:
                add_details(o, t, r)
                json.dump(r, open(f, "w", encoding="utf-8"), indent=1)
            return t, r
        r = lookup(o, t)
        if f:
            json.dump(r, open(f, "w", encoding="utf-8"), indent=1)
        return t, r

    with cf.ThreadPoolExecutor(o["workers"]) as ex:
        while frontier:
            nxt = []
            for t, r in ex.map(visit, frontier):
                data[t] = r
                for u in (r["lineage"].get("upstream") or []):
                    u = u.get("table")
                    if u and u not in depth and depth[t] < o["max_hops"]:
                        depth[u] = depth[t] + 1
                        nxt.append(u)
            print(f"traced {len(frontier)} table(s); {len(nxt)} more upstream", file=sys.stderr, flush=True)
            frontier = nxt
    return data


def stop_reason(t, r):
    ti, fr = r["table"], r["fresh"]
    writes = ti.get("recentWrites") if isinstance(ti.get("recentWrites"), list) else []
    jobs = sorted({str(w["jobId"]) for w in writes if w.get("jobId")})
    users = sorted({w["user"] for w in writes if w.get("user")})
    reason = "no upstream lineage recorded in Unity Catalog"
    if jobs:
        reason += f"; written by job {', '.join(jobs)}"
    elif users:
        reason += f"; last written by {', '.join(users[:2])} (not from a job)"
    m = re.match(r"^[^.]+\.datalake\.([a-z0-9]+)_(dbo|umlu)_([a-z0-9_]+)$", t)
    if m:
        reason += (f"; the name suggests a copy of SQL Server table {m.group(1)}.{m.group(2)}.{m.group(3)}, "
                   "but the loading job's code hasn't been read to confirm it")
    if jobs and fr.get("writerJobNote"):
        reason += "; you can't view the writing job, so its source can't be read"
    elif jobs:
        reason += "; read the writing job's code to go further"
    return reason


def build(o, data, commit):
    nid = lambda t: "dbx:" + t.lower()
    nodes, edges, stops, seen = [], [], [], set()
    for t in sorted(data):
        r = data[t]
        ti, fr, li = r["table"], r["fresh"], r["lineage"]
        node = {"id": nid(t), "system": "databricks", "kind": "view" if "VIEW" in (ti.get("type") or "").upper() else "table"}
        if ti.get("owner"):
            node["owner"] = ti["owner"]
        if fr.get("status") in ("ok", "stale", "failed"):
            if fr.get("lastWrite"):
                node["lastUpdated"] = fr["lastWrite"]
            msg = fr.get("message") or fr.get("writerJobNote") or ""
            if fr["status"] == "stale" and not fr.get("writerJob"):
                msg += ("; created by a person, not a scheduled job, so it may be a one-time snapshot. "
                        "Check whether it's meant to update.")
            fresh = {"status": fr["status"], "lastRun": fr.get("lastWrite"),
                     "job": str(fr["writerJob"]) if fr.get("writerJob") else None, "message": msg}
            node["freshness"] = {k: v for k, v in fresh.items() if v}
        det = r.get("details")
        if det and not det.get("error"):
            node["details"] = {k: v for k, v in det.items() if v not in (None, "", [], {})}
        nodes.append(node)
        ups = [u for u in (li.get("upstream") or []) if u.get("table")]
        evidence = li.get("evidence") or ""
        if not ups and ti.get("viewReads"):
            ups, evidence = [{"table": v, "via": "view"} for v in ti["viewReads"]], "view definition"
        beyond = [u["table"] for u in ups if u["table"] not in data]
        for u in ups:
            k = (nid(u["table"]), nid(t))
            if u["table"] in data and k not in seen:
                seen.add(k)
                edges.append({"from": k[0], "to": k[1], "via": u.get("via") or "", "evidence": evidence,
                              "confidence": "recorded"})
        if not ups:
            stops.append({"node": nid(t), "terminal": "best_known", "reason": stop_reason(t, r)})
        elif beyond:
            stops.append({"node": nid(t), "terminal": "best_known",
                          "reason": f"hop limit ({o['max_hops']}) reached; {len(beyond)} further upstream table(s) not traced"})
    return {"version": 1, "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generatedBy": "databricks-upstream-lineage skill (build_upstream.py)", "pbipCommit": commit,
            "anchors": {}, "nodes": nodes, "edges": edges, "stops": stops}


def main():
    o = parse(sys.argv[1:])
    src = model_tables(o["pbip"])
    seeds = list(src.get("databricksTables") or [])
    df, df_note = (None, None)
    if src.get("dataflowTables"):
        df, df_note = dataflows(o["pbip"])
        if df:
            seeds += [t for t in df["databricksSeeds"] if t not in seeds]
            print(f"dataflows: {len([n for n in df['nodes'] if n['system'] == 'dataflow'])} dataflow node(s); "
                  f"{len(df['databricksSeeds'])} Databricks table(s) they read", file=sys.stderr)
        else:
            print(f"dataflows skipped: {df_note}", file=sys.stderr)
    if not seeds and not df:
        sys.exit("No Databricks or dataflow sources found in that folder.")
    data = crawl(o, seeds) if seeds else {}
    commit = subprocess.run(["git", "-C", o["pbip"], "rev-parse", "--short", "HEAD"],
                            capture_output=True, text=True).stdout.strip() or None
    doc = build(o, data, commit)
    if df:
        merge_dataflows(doc, df)
    os.makedirs(os.path.dirname(os.path.abspath(o["out"])), exist_ok=True)
    with open(o["out"], "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    errors = {t: [c for c in r if isinstance(r[c], dict) and r[c].get("error")] for t, r in data.items()}
    status = {}
    for n in doc["nodes"]:
        s = n.get("freshness", {}).get("status", "n/a")
        status[s] = status.get(s, 0) + 1
    print(json.dumps({"out": o["out"], "modelTables": len(seeds), "nodes": len(doc["nodes"]), "edges": len(doc["edges"]),
                      "bestKnownEnds": len(doc["stops"]), "freshness": status,
                      "notFresh": [n["id"] for n in doc["nodes"] if n.get("freshness", {}).get("status") in ("stale", "failed")],
                      "lookupErrors": {t: c for t, c in errors.items() if c},
                      "unresolvedModelSources": src.get("unresolvedDatabricks") or [],
                      "dataflows": ({"nodes": len([n for n in df["nodes"] if n["system"] == "dataflow"]),
                                     "transformed": [n["name"] + ": " + n["details"]["transform"]["summary"] for n in df["nodes"]
                                                     if n.get("details", {}).get("transform", {}).get("shape") == "transformed"],
                                     "errors": df["errors"]} if df else (f"skipped: {df_note}" if df_note else None))},
                     indent=2))


if __name__ == "__main__":
    main()
