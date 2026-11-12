---
name: databricks-upstream-lineage
description: Trace where a Power BI semantic model's data comes from beyond its source connection — through Databricks (Unity Catalog lineage, view SQL, the jobs and notebooks that write each table, their schedules and recent runs), Power BI dataflows (their Power Query, whether each query passes data through or joins, computes or adds columns, refresh history), Fabric and SQL Server — and check whether the upstream jobs ran, so stale or failed loads can explain a wrong or missing number. Use when someone asks where a table, field or measure's data comes from, why a metric looks off or out of date, whether an upstream job failed, what would have to change upstream to affect a field, or asks to build or refresh the upstream lineage file (.lineage/upstream.json) the Lineage Explorer app shows behind its Upstream toggle. Builds on the power-bi skill for the Power BI side.
---

# Databricks upstream lineage

The Lineage Explorer stops at each table's **source connection** (for MFD models, usually
a Databricks `catalog.schema.table` or view). This skill goes further upstream, using
**read-only** access to Databricks and Power BI, and can write what it finds to
`.lineage/upstream.json` so the app draws it.

Facts first: recorded lineage (system tables, the lineage API, view definitions, Delta
history) beats reading code, and reading code beats guessing. **Never invent a table, job
or system.** Where you can't go further, say where the trail ends and why.

## Connect

- Databricks CLI profile: `genie` (OAuth; host `adb-1234567890123456.7.azuredatabricks.net`).
  If a command says you're not signed in, ask the user to run
  `databricks auth login --profile genie` and finish the browser sign-in.
- SQL warehouse for queries: set `DBX_WAREHOUSE_ID` (your team's shared SQL warehouse ID,
  e.g. an analyst XS warehouse) or pass `--warehouse`.
- Catalogs with hyphens need backticks (`` `facilities-prod`.publish.date_dim ``);
  `scripts/dbx_lineage.py` adds them.
- The `system` catalog may not be readable for your account. The script then falls back to
  the Unity Catalog lineage API and Delta history automatically; mention which evidence
  you used.
- Power BI dataflows: `scripts/dataflow_lineage.mjs` reads them with an `az login` token
  (Power BI API, GET only). For other Power BI service work (workspace scans, dataset data
  sources, the model's own refresh history) see the **power-bi** skill.

## Tools

| Need | Command |
|---|---|
| The model's Databricks tables | `node ../pbip-lineage-analyst/scripts/lineage.mjs sources "<pbip folder>"` → `databricksTables` |
| A table's type, view SQL, recent writes and the jobs behind them | `python scripts/dbx_lineage.py table <catalog.schema.table>` |
| Its upstream tables (recorded lineage) | `python scripts/dbx_lineage.py lineage <catalog.schema.table>` |
| A job's recent runs | `python scripts/dbx_lineage.py runs <job_id>` |
| Is the data current? | `python scripts/dbx_lineage.py fresh <catalog.schema.table> [--stale-hours 30]` |
| What the app's details panel shows: SQL, writer job(s), schedule (set or observed), recent writes, links | `python scripts/dbx_lineage.py details <catalog.schema.table>` |
| Dataflows you can see | `node scripts/dataflow_lineage.mjs list [--workspace <name>]` |
| A dataflow's queries: what each reads, direct / shaped / ⚑ transformed with the steps that change data, refresh history | `node scripts/dataflow_lineage.mjs show <workspaceId> <dataflowId> [--m]` |
| Add the dataflows a model reads to the lineage file (without re-tracing Databricks) | `node scripts/dataflow_lineage.mjs add "<pbip folder>"` |
| Any read-only query | `python scripts/dbx_lineage.py sql "SELECT ..."` |
| Read a job's code | `databricks --profile genie jobs get <id>`, then `MSYS_NO_PATHCONV=1 databricks --profile genie workspace export <path>` (MFD production jobs are asset bundles under `/Workspace/prd/files/repos/<bundle>/main/src/`) |
| Draft the whole lineage file from recorded lineage | `python scripts/build_upstream.py "<pbip folder>" [--cache <dir>]` |
| Check a lineage file | `node scripts/validate-upstream.mjs <file> --pbip "<pbip folder>"` |

## Answering questions

**"Where does this field / measure come from?"**
1. `lineage.mjs measure` (or `search`) to get the model columns and their table.
2. `lineage.mjs sources` for that table's Databricks name.
3. Walk upstream with `lineage`; for views use `table` (view SQL → `viewReads`); for tables
   with no recorded lineage use `table` → `recentWrites` → the writing job → its code.
4. Report the chain in order, with the evidence for each hop, and where it ends.

**"Why does this number look wrong / old?"**
1. Find the chain as above.
2. Run `fresh` on every table in it, nearest first. A `failed` or `stale` table explains
   old numbers in everything downstream of it — name the job, when it last succeeded, and
   its error message. When `writerJobNote` says you can't view the job, say that the
   verdict rests on the table's last write time only, and name the job id so the user can
   ask its owner (many MFD production jobs aren't visible to analysts).
3. Also compare the model's own refresh: ask whether the dataset refreshed after the
   upstream tables were last written (the power-bi skill can read refresh history).
4. If everything is fresh, say so and move to logic: the DAX (pbip-lineage-analyst), view
   SQL, or job code that shapes the field.

**"What SQL builds this table? When did it last run? Is it on a schedule?"**
Run `dbx_lineage.py details` (or read the node's `details` in `.lineage/upstream.json`). Say
where each fact comes from: a schedule from the job's setting vs *observed* from Delta
history; runs from the job's run history vs committed writes (Delta history has no failed
runs). If the writer job isn't viewable, say so, name the job id and who it runs as, and
point to the job link; never guess its code. Tell the user they can see the same thing in
the app: Upstream toggle on, then click the table (ⓘ in the lineage tree, the name in the
Model Diagram's Upstream list, or the Source Table cell in Source Map).

**"Does this dataflow change the data, or just pass it through?"**
`dataflow_lineage.mjs show` gives each query's verdict: **direct** (source as-is, types
only), **shaped** (filters, renames, keeps or removes columns: no new values) or
**transformed** (joins, appends, adds or computes columns, groups, replaces values, custom
SQL that joins or computes, typed-in data). For transformed queries, list the steps that
change the data and quote the relevant Power Query; these are where a dataflow's numbers can
differ from its source. A query built from other queries in the same dataflow (or a linked
table from another dataflow) inherits their changes: follow `reads`.

**"What would we have to change upstream to affect this field?"**
List each hop with the object that produces it (view SQL, job/notebook path, dataflow),
and say which ones belong to which team when known (catalog/schema ownership, job owner).

## Building `.lineage/upstream.json`

Do this on a branch, never `main`. Format: `reference/upstream-file.md`.

**Start with `scripts/build_upstream.py`.** It does steps 1, 2, 5 and 7's inputs for every
Databricks table in one run (recorded links only, every trail end a best-known stop with
its reason) and prints a summary. It also stores each table's `details` for the app's details
panel (`dbx_lineage.py details`: SQL, writer job(s), schedule, recent writes, columns, links;
`--no-details` skips it). When the model reads Power BI dataflows it runs
`dataflow_lineage.mjs collect` first: each dataflow table and the queries and linked
dataflows it's built from become nodes with their Power Query, verdict and refresh history,
and the Databricks tables they read join the trace. Without `az login`, dataflows are
skipped and the summary says so. Then improve the draft by hand: steps 3–4 for ends you
can take further by reading job code, and origins from `reference/origins.md`. Views get
no freshness of their own (`fresh` reports `status: "view"`); they're as current as the
tables they read.

1. List the model's Databricks tables (`sources`). For dataflow and Fabric sources, use
   the power-bi skill to get their definitions and treat each source they read the same way.
2. For each table, walk upstream until a table has no recorded upstream, with a hop limit
   of 8. Record each edge with `via` (job, notebook, pipeline, view) and `evidence`
   (which system table, API or file said so).
3. Where nothing is recorded, you may read view SQL, notebooks or job configuration. Mark
   those edges `"confidence": "inferred"` and quote what you read in `evidence`.
4. Stop at a known source system and mark it `"terminal": "origin"` (see
   `reference/origins.md`). If you can't go further, add a `stops` entry with
   `"terminal": "best_known"` and the reason: no lineage recorded, no permission, external
   system, or hop limit.
5. Run `fresh` on each Databricks node and store `lastUpdated` and `freshness`
   (`status` ok / stale / failed, `lastRun`, `job`, `message`).
6. Add `anchors` only when a model table's own source name doesn't already match a node id
   (`dbx:catalog.schema.table` matches automatically).
7. `validate-upstream.mjs <file> --pbip <folder>` must report `readable: true`; fix every
   best-known end without a reason, and mention `coverage.missing` to the user.
8. Write it to `<pbip folder>/.lineage/upstream.json`, show a summary (tables traced,
   origins, best-known ends with reasons, inferred links, stale or failed jobs, overdue
   writes, ⚑ transformed dataflow queries) and offer to commit it. Don't push or merge.
9. Tell the user how to see it: run the app (`start.bat`), open the project folder, click
   **Upstream** in the toolbar, then click any upstream table (ⓘ in the lineage tree) for
   its SQL or Power Query, schedule and recent runs.

## Don't

- Don't run anything that writes: no `INSERT/UPDATE/DELETE/MERGE/CREATE/DROP`, no job runs,
  no refreshes. The script refuses non-read SQL; don't work around it.
- Don't put tokens or secrets in commands, files or chat (see the power-bi skill's Secrets).
- Don't present an inferred link as recorded, or a best-known end as an origin.
