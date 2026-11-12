# Comparing versions

The app's Version Compare, the GitHub compare report and `compare-local` all use the same
comparison engine (`compareFileMaps` in packages/core), so their results agree.

## Ask first

> Do you want to compare the copy cloned on this computer, or the repository on GitHub?
> The local clone is quickest and can include changes you haven't committed; GitHub is
> better for a pull request or a branch you haven't pulled.

## Local clone

```
node scripts/lineage.mjs compare-local "<repo folder>" --base main --head dev/my-branch
node scripts/lineage.mjs compare-local "<repo folder>" --worktree          # uncommitted changes vs main
```

- The base side is the **merge-base** of base and head (what a pull request shows), not
  the current tip of `main`.
- Output: `summary` (counts by kind and group, `security` and `broken` counts) and
  `changes.modified` / `changes.additions`, grouped as the app groups them: measures,
  columns, data sources, relationships, RLS roles, reports, pages, visuals, filters,
  bookmarks.
- If the folder isn't a git repository, say so and ask for the clone's path.

## GitHub (online)

- From this repo: `integrations/github-compare` builds `pbip-compare.mjs`
  (`node dist/pbip-compare.mjs --repo MFD-Eng/<repo> --pr 23 --out report.html`), with a
  token in `GITHUB_TOKEN`. With no `--head` or `--pr` it picks the newest open pull
  request, else the most recently pushed branch.
- From Python / Databricks: `from mfd_utils import pbip_compare;
  r = pbip_compare.compare("pbiws_area_dashboards", pr=23)`; `r.records` is a DataFrame of
  the same records, `r.html_path` the report.

## Using the result as context

- Lead with what matters: RLS (`security`) changes, anything `broken` (a deleted object
  something still references), data source changes, then measure DAX changes, then report
  layout changes (visuals, filters, bookmarks).
- For each changed measure, run `measure` on the head version to say which reports and
  visuals will show different numbers.
- Answer follow-ups ("did anything change on the Stake page?") from the records rather
  than re-running everything.
