# Measure change protocol

Run these checks before changing any measure, and tell the user what you found in plain
words. The user decides; your job is to make the consequences visible first.

## 1. Editing a measure's DAX

1. `lineage.mjs measure <folder> --name "Table[Measure]"`
   - Tell the user: "This measure feeds N other measures and M visuals in K reports," and
     list them as report > page > visual. Those visuals will show the new result.
2. Save the proposed DAX to a temporary file and run
   `lineage.mjs change-impact <folder> --name "Table[Measure]" --new-dax-file <file>`.
3. Read `removedReferences`:
   - `usedElsewhere: true` — the measure or column taken out of this formula is still used
     by other measures or visuals. Say so, list where, and explain the likely situation:
     someone found this measure wrong and is routing around a component. If the component
     itself is wrong, the other places that use it are probably wrong too, including ones
     nobody has reported yet. Offer to inspect the removed reference (its DAX, where it's
     used, whether it's calculated correctly there) before continuing. Fixing it at its
     source may resolve more than the reported issue; making a new measure leaves the
     others as they are. **The user chooses.**
   - `usedElsewhere: false` — mention briefly that nothing else uses it, and that it may
     become an orphan (check with `orphans` afterwards).
4. Read `addedReferences`: a new dependency on a measure that is itself an orphan or
   filter-only is worth a sentence.

## 2. Renaming a measure

Every DAX reference, visual binding, field parameter and filter that uses the old name
breaks unless updated. List them all from `measure` (`directDependents`, visuals,
`activeFilters`) and, for workspaces, every report. Power BI Desktop updates references
inside the model when you rename there, but **not** visuals in other reports bound to the
same model, nor report-level filters saved with the old name. Recommend renaming in
Desktop and then checking each listed report.

## 3. Deleting a measure

Use the orphan category from `measure.usage.category`:

| Category | Say |
|---|---|
| `true` | Nothing uses it. Safe to delete. |
| `visual` | Only other measures use it, and none of those reach a visual. Deleting breaks those measures; delete them together or not at all. |
| `filterSecurity` | A filter or RLS role uses it. Deleting changes what users see or are allowed to see. Don't delete without the owner's say. |
| `none` | Visuals use it. Deleting breaks them. List them. |

Never call something unused while the summary warned about PBIR-Legacy reports.

## 4. Calculation groups and field parameters

- A calculation item applies to many measures at query time. Changing it changes every
  visual that uses a measure through that calculation group — say so even if `measure`
  shows only a few direct references.
- A measure listed in a field parameter can appear in a visual that doesn't bind it
  directly. `measure` includes those visuals; point out the field parameter by name.

## 5. After the edit

- Make edits on a branch, with Power BI Desktop closed for that project.
- Run `measure` again: confirm the new references are what was intended.
- Run `compare-local <folder> --worktree` and summarize the change for the user.
- Suggest a short note for the pull request: what changed, why, and which reports/visuals
  will show different numbers.
