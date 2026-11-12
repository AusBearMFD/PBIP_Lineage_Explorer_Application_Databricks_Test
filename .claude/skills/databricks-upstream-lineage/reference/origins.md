# Known origins

Systems treated as **origins** (★): operational sources where the data is created, so a
trail that reaches them is complete. Keep this list short and agreed with the team; add
to it rather than deciding case by case, so marks stay consistent between runs.

| System | How it shows up upstream | Mark |
|---|---|---|
| TRIRIGA (facilities management) | SQL Server / Oracle tables ingested by Databricks jobs; schemas such as `tririga`, `dbo.*propertyentity*` | origin |
| SAP | SAP extracts landed in Databricks raw schemas | origin |
| Church membership / attendance systems | Feeds landed in Databricks raw schemas | origin |
| Manual uploads (Excel/CSV to a volume or SharePoint) | `file:` nodes, `/Volumes/.../raw/...` paths in job code | origin, note "manual upload" |
| External vendor APIs | `api:` nodes from `Web.Contents` or job code | best known, reason "external system" unless the vendor is the true source |

When a trail ends somewhere not on this list, use **best known** with a reason, and
suggest adding the system here if it's a real source.

_This list is a starting point; confirm it with the data engineering team._
