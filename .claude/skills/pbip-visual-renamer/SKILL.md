---
name: pbip-visual-renamer
description: Give Power BI visuals meaningful Selection-pane names in PBIR reports — find visuals still called by their default type name ("Card", "Matrix", "Text box", "Group 3") and visuals sharing a name with another visual on the same page, propose descriptive names from what each visual shows, and after approval rename them and report every change (report, page, visual, before, after, reason). Use when someone asks to rename, label or clean up visual names, fix duplicate visual names, or make the Selection pane or Lineage Explorer easier to read.
---

# PBIP visual renamer

Default names make the Selection pane, bookmarks, the Lineage Explorer and any review of
the report hard to follow. This skill finds them, proposes better names, and renames them
**only after the user approves the plan**.

## Where the name lives (read before changing anything)

- **Groups**: `visualGroup.displayName` in the group's `visual.json`. Safe to change: it
  only shows in the Selection pane.
- **Every other visual**: its **title text**
  (`visual.visualContainerObjects.title[0].properties.text`). With no title text, the
  Selection pane shows the visual type, which is the "default name".
  The same text is the visual's on-canvas title **when the title is switched on**, so:
  - `titleShow: "false"` — renaming is invisible to report readers. Safe.
  - `titleShow: "unset"` — Power BI's default applies, and for many visual types (charts,
    tables) that means the title shows. Rename with `keepTitleHidden: true`, which also
    writes show = false so nothing appears on the canvas. Tell the user this is what you'll
    do, and that a visual which currently shows an automatic title ("Sum of X by Y") would
    lose it; list those visuals (charts and tables) separately for a yes/no.
  - `titleShow: "true"` — renaming changes the title readers see. Never do this without
    explicit approval for that visual (`changeVisibleTitle: true` in the plan).
  - A title set by an expression (`nameSource: "conditionalTitle"`) is never changed.

## Steps

1. Ask which project folder (and reports) to work on. Check Power BI Desktop is **closed**
   for those reports and the work is on a branch (not `main`), with no uncommitted changes
   to the report files.
2. List: `node scripts/visual-names.mjs list "<folder>" --only-candidates --out visuals.json`
   (add `--report "<name>"` to limit). PBIR-Legacy reports are skipped and listed in
   `legacyReportsSkipped`; tell the user they need converting first.
3. Propose names (rules below) as a table grouped by report > page: visual, type, current
   name, proposed name, reason (`default name` or `duplicate name`), title switch. Put
   visible-title visuals in a separate section that needs explicit approval. Skip purely
   decorative shapes and images unless the user wants them named.
4. After approval, write the plan file and apply:
   `node scripts/visual-names.mjs apply plan.json --dry-run` (check), then without
   `--dry-run`. It writes `visual-rename-report.csv` and `.md`.
5. Give the user the final list: **report, page, visual id, type, name before, name after,
   reason** (from the `.md`), plus anything skipped and why. Suggest opening one report in
   Power BI Desktop to confirm the Selection pane before committing.

Plan file:
```json
{ "folder": "C:/Users/.../pbiws_pf_maps_db_prod",
  "renames": [
    { "file": "Area.Report/definition/pages/<page>/visuals/<id>/visual.json",
      "newName": "Attendance vs capacity by stake", "reason": "default name", "keepTitleHidden": true } ] }
```

## Naming rules

- Say what the visual shows, in sentence case, 2–6 words, no type prefix unless it helps
  tell visuals apart: "Attendance trend by quarter", "Open projects", "Region slicer".
- Use the hints: fields (measures first, then the main grouping column), text box text,
  button text and action ("Go to Stake page" from a page-navigation button), slicer field.
  Use the model's measure names, not raw column names like `area_dashboard_pemd[...]`.
- Duplicates on one page: make each name distinct by what differs — field, filter, purpose
  or position ("Region slicer (filter panel)", "Region slicer (main)"). When one copy is
  hidden and swapped in by a bookmark, say so ("Region slicer – bookmark: Expanded").
- Groups: name the set ("Navigation buttons", "Header", "KPI cards – membership").
- Keep names unique per page and under 60 characters. Don't use quotes or brackets that
  could be confused with DAX.
- If you can't tell what a visual is for, say so and leave it for the user rather than
  inventing a name.
