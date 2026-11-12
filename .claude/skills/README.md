# Agent skills for Power BI (PBIP Lineage Explorer)

Skills that Claude Code (or another agent that reads `SKILL.md` files) loads when working
in this repository. The lineage scripts run this app's own engine (`packages/core`), so the
agent sees what the app shows.

| Skill | Use it to |
|---|---|
| [pbip-lineage-analyst](pbip-lineage-analyst/SKILL.md) | Answer questions about a PBIP project: lineage, dependencies, which reports/pages/visuals use a measure, orphans, sources, version comparisons (local clone or GitHub). Includes the impact protocol for editing measures. |
| [databricks-upstream-lineage](databricks-upstream-lineage/SKILL.md) | Trace data upstream of the source connection through Databricks and Power BI dataflows, check whether upstream jobs ran, and build `.lineage/upstream.json` for the app's Upstream toggle. Each table carries its SQL or Power Query, writing job, schedule and recent runs, shown when you click it in the app; dataflow queries that join, add columns or compute are flagged. |
| [pbip-visual-renamer](pbip-visual-renamer/SKILL.md) | Rename visuals still called "Card", "Matrix", "Group 3"..., and duplicates on a page, with a before/after report. |
| [pbi-desktop-batch-save](pbi-desktop-batch-save/SKILL.md) | Open, save and close every report in a folder with Power BI Desktop: convert PBIR-Legacy reports to PBIR, or re-save. |

Requirements: Node 18+; Python 3.9+ and the Databricks CLI signed in
(`databricks auth login --profile genie`) for the Databricks skill, plus `az login` when a
model reads Power BI dataflows; Power BI Desktop and
Windows PowerShell for batch save.

**Engine.** `pbip-lineage-analyst/scripts/lib/load-core.mjs` uses this repo's live
`packages/core` when it has everything the skills need, otherwise the bundled copy
`lib/pbip-lineage-core.mjs` (built from the Databricks-enhanced engine). `lineage.mjs summary`
reports which (`engine`).

**Master copy.** These skills are maintained in the personal Claude Code plugin
`~/.claude/skills/power-bi/` (loaded in every project as `/power-bi:<skill>`) and copied here
with `~/.claude/skills/power-bi/tools/Sync-PowerBISkills.ps1`. Edit them there, then sync.

Try them on any PBIP folder, for example:

```
node .claude/skills/pbip-lineage-analyst/scripts/lineage.mjs summary "C:/Users/<you>/Documents/GitHub/pbiws_area_dashboards"
```
