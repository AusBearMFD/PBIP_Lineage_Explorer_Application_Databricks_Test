---
name: pbip-lineage-analyst
description: Understand and report on a Power BI PBIP project the way the PBIP Lineage Explorer app does — measure lineage (visual → measure → column → table → Power Query → source), downstream impact, which reports, pages and visuals use a measure, orphaned (unused) measures and columns, data sources (including Databricks catalog.schema.table), and differences between versions in a local clone or on GitHub. Use when someone asks what a measure does or depends on, where something is used, what breaks if they change or delete it, which measures are unused, what changed between branches or commits, or asks to edit a measure's DAX (this skill's change protocol then applies). For tracing data upstream of the source connection into Databricks, also use databricks-upstream-lineage.
---

# PBIP lineage analyst

You answer questions about a PBIP project with the **same engine the PBIP Lineage
Explorer app uses** (`packages/core`), run through `scripts/lineage.mjs`. Facts come
from the engine; you explain them, connect them to the question, and point out risks.
Never guess lineage from file names or by reading a few files by hand when the engine
can answer.

## Before you start

1. Find the PBIP folder: the folder holding `*.Report` and `*.SemanticModel` folders
   (often a repo root such as `C:\Users\<you>\Documents\GitHub\pbiws_*`). Ask if unclear.
2. Run `node scripts/lineage.mjs summary "<folder>"` and read `warnings` first.
   - **PBIR-Legacy reports** (`report.json`, no `definition/pages`): the engine can't read
     their visuals, so visual counts and orphan results are incomplete. Say so in every
     answer that depends on visuals, and suggest converting the reports to PBIR.
   - A missing `.lineage/upstream.json` just means no upstream lineage beyond the source
     connection; see the databricks-upstream-lineage skill.
3. Paths: on Windows pass `C:/Users/...` style paths (Git Bash `/c/...` paths don't reach Node).
   Node 18+ is required. Inside the app repo the script uses the app's live engine
   (`packages/core`); anywhere else it uses the bundled copy in `scripts/lib/`. `summary`
   reports which one (`engine`).

## Commands (all print JSON)

| Question | Command |
|---|---|
| What's in this project? | `summary <folder>` |
| Find a measure, column or table | `search <folder> --q <text>` |
| Everything about one measure | `measure <folder> --name "Table[Measure]"` |
| Unused measures and columns | `orphans <folder>` |
| Visuals on a report or page | `visuals <folder> [--report R] [--page P]` |
| Data sources (Databricks names, SQL, Fabric) and upstream summary | `sources <folder>` |
| What does this DAX edit affect? | `change-impact <folder> --name "Table[Measure]" --new-dax-file f.dax` |
| Differences between two versions in a local clone | `compare-local <folder> [--base main] [--head <ref> \| --worktree]` |

Read `reference/app-model.md` once per session: it explains layers, node and edge types,
how visuals and filters are read, field parameters, calculation groups, RLS, orphan
categories and multi-report workspaces, so your wording matches what users see in the app.

## Answering well

- Lead with the answer, then the evidence: e.g. "It's used by 14 visuals in 3 reports"
  followed by the report > page > visual list (`measure` gives it grouped already).
- Always name **reports and pages**, not just visual ids. In multi-report workspaces the
  same model feeds several reports; say which.
- Distinguish **direct** dependents from **transitive** ones (`directDependents` vs
  `allDependentMeasures`).
- For orphans, use the app's categories and their risk: completely unused (safe to delete
  after a check), used only by other measures (wired in but never shown), filter/security
  only (doing work — risky to delete). Never call a measure unused while legacy reports
  were skipped.
- Give feedback when you see it: duplicated logic, measures with no format string, deep
  chains of measures, unused columns pulled from the source (refresh cost), hard-coded
  values in DAX, a measure named for one thing but computing another.
- Keep answers short; offer the full list rather than pasting hundreds of rows.

## Changing a measure — the impact protocol (always)

When the user asks you to edit, rename or delete a measure, **before making the edit**:

1. Run `measure` on it and tell the user what depends on it: dependent measures (direct
   and transitive), and the **reports, pages and visuals** that will show the new result.
   For a delete or rename, everything listed will break unless updated.
2. Write the proposed DAX to a temp file and run `change-impact`. If `removedReferences`
   shows a measure or column that is **still used elsewhere** (`usedElsewhere: true`),
   tell the user plainly, for example:

   > You're replacing `[Total Attendance]` in this formula. `[Total Attendance]` is also
   > used by 3 other measures and 12 visuals in 2 reports (listed below). If it's being
   > swapped out because it's wrong, those places may have the same problem — and the
   > issue that prompted this change may only be the first one reported. Fixing
   > `[Total Attendance]` itself might resolve all of them. Do you want me to look at how
   > it's calculated and where it's used before we continue?

   This is a courtesy, not a block: the user decides. Edits of this kind (swapping a
   numerator or denominator for a new measure or field) usually come from a bug ticket.
3. Make the edit only after that, on a branch (never on `main`), with Power BI Desktop
   closed for that project. Afterwards run `measure` again to confirm the new references,
   and `compare-local --worktree` to show the user exactly what changed.

See `reference/measure-change-protocol.md` for more cases (renames, deletes, calculation
groups, field parameters).

## Comparing versions — ask which one

When the user wants to compare versions or review a branch or pull request, **ask** which
they mean before running anything:

- **The local clone on this computer** (fast, includes uncommitted work):
  `compare-local <folder> --base main --head <branch>` or `--worktree` for uncommitted
  changes. Compares from the merge-base, like a pull request.
- **The GitHub repository online** (a pull request or a branch not pulled locally): use the
  repo's `integrations/github-compare` tool or, from Python, `mfd_utils.pbip_compare`
  (`from mfd_utils import pbip_compare; pbip_compare.compare("pbiws_area_dashboards", pr=23)`),
  which writes the same HTML report the app shows. Needs a GitHub token.

Then use the result as context: summarize by area (measures, columns, data sources,
visuals, filters, bookmarks, RLS), call out anything flagged `security` or `broken`, and
answer follow-up questions from it. See `reference/comparisons.md`.

## Don't

- Don't edit PBIP files while Power BI Desktop has that project open.
- Don't claim lineage the engine didn't return; if it can't see something (legacy reports,
  a calculated table's logic, a report-level measure), say so.
- Don't run `compare-local` against a folder that isn't a git repository; ask for the clone.
