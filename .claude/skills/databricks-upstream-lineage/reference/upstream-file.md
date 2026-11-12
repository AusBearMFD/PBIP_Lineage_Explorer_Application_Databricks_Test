# `.lineage/upstream.json` (version 1)

Read by the app (`packages/core/src/upstream/upstreamLineage.js`) when a project folder is
opened. Put it at the root of the folder the user opens in the app (the repo root that
holds the `.Report` / `.SemanticModel` folders).

```json
{
  "version": 1,
  "generatedAt": "2026-11-06T15:20:00Z",
  "generatedBy": "databricks-upstream-lineage skill",
  "pbipCommit": "fe6ccf6",
  "anchors": { "Area Dashboard/area_dashboard_pemd": "dbx:mfd.prd.area_dashboard_pemd" },
  "nodes": [
    { "id": "dbx:mfd.prd.area_dashboard_pemd", "system": "databricks", "kind": "view" },
    { "id": "dbx:mfd.stg.property_entity_master", "system": "databricks", "kind": "table",
      "lastUpdated": "2026-11-06T05:30:00Z",
      "freshness": { "status": "failed", "lastRun": "2026-11-06T05:30:00Z", "job": "area_refresh",
                     "message": "last 2 runs failed: ..." } },
    { "id": "sql:tririga.dbo.propertyentity", "system": "sqlserver", "kind": "table", "terminal": "origin" }
  ],
  "edges": [
    { "from": "dbx:mfd.stg.property_entity_master", "to": "dbx:mfd.prd.area_dashboard_pemd",
      "via": "view", "evidence": "view SQL: FROM mfd.stg.property_entity_master", "confidence": "recorded" },
    { "from": "sql:tririga.dbo.propertyentity", "to": "dbx:mfd.stg.property_entity_master",
      "via": "job:tririga_ingest", "evidence": "DESCRIBE HISTORY: WRITE by job tririga_ingest; job code reads dbo.propertyentity",
      "confidence": "inferred" }
  ],
  "stops": [
    { "node": "dbx:mfd.raw.manual_overrides", "terminal": "best_known", "reason": "no upstream lineage recorded" }
  ]
}
```

## Rules

- **Edges point downstream**: `from` feeds `to`.
- **Node ids** are `<prefix>:<name>`, prefix by system: `dbx:` Databricks
  (`catalog.schema.table`, lower case as Unity Catalog shows it), `sql:` SQL Server
  (`database.schema.table`), `fabric:` Fabric item, `pbi-df:` Power BI dataflow (its name),
  `file:` file drop, `api:` API endpoint, `ext:` anything else.
- `system`: `databricks`, `sqlserver`, `fabric`, `dataflow`, `file`, `api`, `external`.
- `kind`: `table`, `view`, `dataflow`, `file`, `endpoint`...
- `confidence`: `recorded` when a system said so (lineage table/API, view definition, Delta
  history, dataflow definition), `inferred` when you concluded it from reading code.
  Inferred links are drawn dashed and can be hidden in the app.
- `terminal`: `origin` = a known source system, nothing further expected (★).
  `best_known` (in `stops`, with a `reason`) = you couldn't go further (☆).
  A node with nothing feeding it and no terminal is shown as best known.
- `freshness.status`: `ok`, `stale` or `failed`. Stale and failed nodes are flagged ⚠ in
  the app, so a reader sees which numbers may be out of date.
- `anchors`: only needed when a model table's source doesn't match a node id on its own.
  Keys are `"Model/Table"` or `"Table"`.
- `pbipCommit`: the short commit of the PBIP repo you traced (`git rev-parse --short HEAD`).
- `details` (optional, any node): what the app's details panel shows when the node is clicked.
  `build_upstream.py` and `dataflow_lineage.mjs` fill it; every key is optional:

  | Key | Holds |
  |---|---|
  | `sql`, `sqlSource` | View SQL, or the writing job's SQL task / notebook cells, and where it came from |
  | `sqlNote` | Why no SQL is shown (job not viewable, created by a person...) |
  | `mQuery` | A dataflow query's Power Query (M) |
  | `transform` | `analyzeMQuery` result: `shape` (`direct`/`shaped`/`transformed`), `summary`, `flags`, `changes` [{category, label, step, detail}], `sources`, `references`. The app computes it from `mQuery` when missing |
  | `dataflow` | `{ name, id, workspace, workspaceId, modified }` |
  | `writer` | `{ jobId, jobName, runAs, operation, visible, note, tasks?, allJobs? }` |
  | `schedule` | `{ summary, source, cron?, timezone?, paused?, observed?, intervalHours?, overdue?, message? }`; `source` says whether it's the job's setting or observed |
  | `runs`, `runsSource` | Recent runs or refreshes `[{ time, status, operation?, rows?, runId?, job?, by?, trigger?, message?, url? }]` and where they came from |
  | `columns` | Column names |
  | `links` | `[{ label, url }]` (https only): Catalog Explorer, the job, the run, the dataflow |

  Dataflow nodes: id `pbi-df:<dataflowId>/<query name>` (a model table that reads a dataflow
  anchors to it automatically), `system: "dataflow"`, `kind: "dataflow table"` (loaded) or
  `"dataflow query"` (a helper query), name `<dataflow> / <query>`.
- The file holds names, code and run metadata only — never data, credentials or connection
  secrets. Power Query and SQL can name servers, as the model's own TMDL already does.
