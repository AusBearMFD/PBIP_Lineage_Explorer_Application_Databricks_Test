# GitHub Compare (`integrations/github-compare`)

Compares two versions of a PBIP repository on GitHub and writes a single-file HTML report
with this app's **Version Compare** and **Model Diagram** views, plus every change as JSON.

It is the engine behind `mfd_utils.pbip_compare`. Everything GitHub-specific lives in this
folder; the app's core (`packages/core`) and views (`src/ui`) are imported unchanged, and the
app itself still reads only local clones. The illustrated write-up is
[docs/GITHUB-COMPARE-GUIDE.html](../../docs/GITHUB-COMPARE-GUIDE.html).

## What it compares

By default it reads from the GitHub API and picks the two versions itself:

| | Default | Override |
|---|---|---|
| Head | Newest open PR's branch, else the most recently pushed branch | `--head <branch>` or `--pr <n>` |
| Base | The PR's base branch, else the repository's default branch | `--base <branch or sha>` |
| Comparison | Tip of base vs tip of head ("All changes"), then each branch commit vs its parent | `--max-commits <n>` (default 30; 0 = overall only) |

The report header states which rule picked head. If base has commits the branch doesn't, the
report warns that some differences in "All changes" come from base.

## Use it directly

```bash
cd integrations/github-compare
npm install
npm run build
GITHUB_TOKEN=$(gh auth token) node dist/pbip-compare.mjs --repo MFD-Eng/pbiws_area_dashboards --out report.html --json records.json
```

Most people run it through mfd_utils instead:

```python
from mfd_utils import pbip_compare
pbip_compare.compare("pbiws_area_dashboards", token=token)
```

## Contract (what mfd_utils depends on)

```
node pbip-compare.mjs --repo <owner/name> [--head <branch> | --pr <n>] [--base <ref>]
                      [--max-commits 30] [--out report.html] [--json records.json]
node pbip-compare.mjs --version        → {"version": "...", "commit": "...", "contract": 1}

env     GITHUB_TOKEN (never passed as an argument, never written to output)
stdout  last line is a JSON summary: html, json, base, head, headReason, baseAheadBy,
        branchCommits, pairs, records, overall, warnings, githubRequests, seconds, htmlBytes
exit    0 ok · 2 bad arguments · 3 auth · 4 repo/branch/PR not found or nothing to compare · 5 partial
```

Raise `contract` in `cli/pbip-compare.js` only for breaking changes to the arguments, the
summary or `records.json`. mfd_utils refuses a tool whose contract it doesn't know.

## How it reads GitHub

1. `GET /repos/{repo}`, `/pulls`, `/activity` pick the branches.
2. `GET /compare/{base}...{head}` lists the branch commits and how far base is ahead.
3. `GET /git/trees/{sha}?recursive=1` lists each version's PBIP files (`.tmdl`, `.json`, `.pbir`).
4. A version with more than 100 uncached files is downloaded as one `tarball`; the rest come from
   `GET /git/blobs/{sha}`. Files are cached by git blob id, so each file version downloads once.

Measured on `pbiws_area_dashboards` (about 2,300 PBIP files): a 1-commit PR took 6 seconds and
70 requests; a 20-commit range took 32 seconds and 231 requests.

## Report

The page embeds the computed comparison (not the raw files), gzipped and base64-encoded, and
unpacks it with the browser's `DecompressionStream`. Model snapshots are stored once and shared
between pairs. The 20-commit range above made a 1.9 MB report.

## Releases

`.github/workflows/pbip-compare-release.yml` builds, tests and publishes `dist/pbip-compare.mjs`
and its `.sha256`:

| Event | Release tag | Used by mfd_utils when |
|---|---|---|
| Push to `main` touching this folder, the core or the two views | `pbip-compare-main-latest` (replaced each time) | `tool_version="main"` (default) |
| Run workflow manually on `main` | `pbip-compare-v<package.json version>` | `tool_version="v0.1.0"` |

## Folder layout

```
build/build.mjs            esbuild: report bundle + CLI with the report embedded
cli/pbip-compare.js        arguments, exit codes, summary
src/sources/githubSource.js  GitHub REST reads, blob cache, tarball seeding
src/refs.js                picks head and base
src/history.js             overall pair + one pair per branch commit
src/payload.js             what the report embeds
src/records.js             flat rows for records.json
src/report/                page shell and entry (mounts the existing views)
tests/                     node:test, offline, using public/sample-pbip
```

## Notes

- Only `--source github` is implemented. Local clones are a later addition.
- The report build takes just `highlightDax` from `src/ui/lineageView.js` instead of the whole
  file, because bundling `lineageView.js` pulls in `src/ui/lineageTree.js`, which reassigns a
  `const` (near line 521). That is a bug in the app worth fixing on its own.
- Reports contain DAX, M and filter values from the compared repository. Share them the way you
  share that repository.
