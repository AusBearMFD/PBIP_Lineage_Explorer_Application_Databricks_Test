# How the PBIP Lineage Explorer reads a project

This is the model behind every answer. Use the same words the app uses.

## What gets read

| Part | Files | What the engine takes from them |
|---|---|---|
| Semantic model | `*.SemanticModel/definition/tables/*.tmdl` | Tables, columns (data type, source column, hidden, calculated), measures (DAX, format string, description), partitions (Power Query M, storage mode) |
| | `expressions.tmdl` | Shared Power Query queries and **parameters** (e.g. `DBX_Catalog`); parameters are substituted into M before sources are detected |
| | `relationships.tmdl` | Relationships (from/to column, cardinality, cross-filter, active) |
| | `roles/*.tmdl` | Row-level-security roles and the fields their filters use |
| Report (PBIR) | `*.Report/definition/pages/<page>/page.json` | Page name, page-level filters |
| | `.../visuals/<visual>/visual.json` | Visual type, title, the fields in each data role, visual-level filters, group membership |
| | `definition/report.json` | Report-level filters |
| | `definition/bookmarks/*.json` | Bookmarks (used by Version Compare) |
| Report (PBIR-Legacy) | `*.Report/report.json` only | **Visuals are not read.** Only report-level filters. Convert to PBIR for full results |

A folder with several `.Report` folders is a **workspace**: every report is analyzed
against the semantic model its `definition.pbir` points to (`byPath`), and visuals carry
their **report name**. Several models can be loaded at once; models other than the most
used one get their node ids prefixed with `model:<path>§`.

## The six lineage layers (plus upstream)

| Layer | Name in the app | Meaning |
|---|---|---|
| 1 | Report Visual | A visual on a page (in a report) |
| 2 | DAX Measure | The measure being looked at |
| 3 | DAX Sub-Measure | Measures it references, recursively |
| 4 | PBI Table & Column | Model columns the DAX touches, grouped by table; renamed columns show their source name |
| 5 | Power Query | The M expression or shared query that loads the table |
| 6 | Source Connection | The server/database/table the M reads (SQL, Databricks, Fabric/Lakehouse, BigQuery, web, file) |
| 7 | Upstream Source | Only with `.lineage/upstream.json` and the Upstream toggle on: where the source table's data comes from, ending in ★ origin or ☆ best known |

### Upstream details panel

With the Upstream toggle on, clicking an upstream table opens a side panel (the ⓘ button on
an upstream node in the lineage tree, a name in the Model Diagram panel's "Upstream lineage"
list, or the Source Table / Upstream Table cell in Source Map). It shows the node's `details`
from `.lineage/upstream.json`: status and freshness, schedule (the job's setting, or
*observed* from Delta history or refresh history), recent runs or refreshes, the writing
job(s) or dataflow, view SQL / job code / the dataflow's Power Query, what feeds it and what
it feeds, columns and links. Dataflow tables get a verdict from the engine's `analyzeMQuery`:
**Direct** (source plus types), **Shaped** (filters, renames, keeps/removes columns; no new
values) or **⚑ Transformed** (joins, appends, new or computed columns, grouping, replaced
values, custom SQL that joins or computes, typed-in data), with the steps that change the
data. ⚑ also marks those tables in the tree and the Model Diagram list. When a user asks
about something in that panel, read the same node in the file (or re-run
`dbx_lineage.py details` / `dataflow_lineage.mjs show`) so your answer matches the panel.

## Graph: node and edge types

Nodes: `table`, `column`, `measure`, `visual`, `page`, `source`, `expression`, `role`.
Ids look like `measure::Table.Measure`, `column::Table.Column`, `table::Table`,
`visual::<page>/<visual>§report:<report key>` in workspaces.

Edges point from consumer to what it uses (so "upstream" of a visual is its measures):

| Edge | Meaning |
|---|---|
| `visual_to_field` | A visual uses a measure or column (role recorded when known) |
| `visual_to_page` | A visual sits on a page |
| `measure_to_measure`, `measure_to_column` | DAX references |
| `measure_to_userelationship` | `USERELATIONSHIP` in DAX |
| `calc_column_to_column`, `calc_column_to_measure` | Calculated column DAX references |
| `column_to_table`, `table_relationship` | Model structure |
| `table_to_expression`, `table_to_source`, `expression_to_source` | Power Query and source connection |
| `column_to_source_column`, `table_to_table_join` | Renames and M joins (`Table.NestedJoin`) |
| `field_param_to_field` | A field parameter can show this field |
| `filter_to_field` | An **active** report/page/visual filter uses this field (filters with nothing selected are ignored) |
| `rls_to_field` | An RLS role's filter uses this field |

## Enrichments the engine understands

- **Field parameters**: a visual bound to a field parameter can show any of its fields, so
  each listed measure counts as used by that visual ("FP" binding in the app).
- **Calculation groups**: calculation items apply to measures at query time; the engine
  links them so impact passes through.

## Orphans (Model Health)

| Category (engine name) | Meaning | Advice |
|---|---|---|
| none | Reaches at least one visual | In use |
| `filterSecurity` | Reaches no visual, but an active filter or RLS role uses it | Doing work; risky to delete |
| `visual` | Other measures use it, but none of them reach a visual | Wired in, never shown; check before deleting |
| `true` | Nothing uses it at all | Safe to delete after a quick check |

Unused columns: no measure, visual, relationship, filter or role uses them. They still cost
refresh time and model size if the source query loads them.

## Data sources

`sources` lists each table's source. Databricks tables show the full
`catalog.schema.table` and whether it's a table or view, from `Databricks.Catalogs`,
`DatabricksMultiCloud.Catalogs` or `Databricks.Query` (native SQL lists every table it
reads). A source whose catalog or schema comes from an unresolved parameter is listed in
`unresolvedDatabricks`.

## What the engine can't see

- Visuals in PBIR-Legacy reports (see above).
- Report-level measures defined only in a report's `reportExtensions.json` are read as
  report content, not model measures.
- Logic inside calculated tables beyond their DAX references.
- Anything upstream of the source connection, unless `.lineage/upstream.json` exists.
