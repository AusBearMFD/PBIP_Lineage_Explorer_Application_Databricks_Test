---
name: pbi-desktop-batch-save
description: Open, save and close every Power BI file in a folder with Power BI Desktop, one at a time, unattended — most often to convert PBIP reports from PBIR-Legacy (report.json) to PBIR (one visual.json per visual), or to re-save reports/.pbix files so a newer Desktop rewrites them. Clicks Desktop's own Save and Close buttons through UI Automation, so it works while the user keeps using other windows, checks each result and logs it. Use when someone asks to convert reports to PBIR, upgrade or re-save all reports in a folder/repo/workspace, or "open and save all the Power BI files" in a folder.
user-invocable: true
---

# Batch open, save and close in Power BI Desktop

Power BI Desktop has no command-line save or convert. `scripts/Save-PowerBIFiles.ps1`
does what a person would, one file at a time: open in Desktop → wait until loaded →
click **Save** → wait until the save is written → click **Close** → check → log.

## Why it works this way (don't "simplify" these)

- **UI Automation clicks, not keystrokes.** Windows refuses `SetForegroundWindow` while
  the user is busy in another window, so Ctrl+S lands in the wrong app. Invoking
  Desktop's own `Save` and `Close` buttons works with Desktop in the background. Ctrl+S
  is only a fallback, sent after checking Desktop really is in front.
- **Close with Desktop's Close button.** Desktop ignores `CloseMainWindow` / a plain
  close request. Never kill the process: that can lose the save.
- **Feature pop-ups block closing.** A "Try it now"-style pop-up has a `Close Dialog`
  button; the script clicks it first.
- **"View recovered files" banner** (auto-recovery from earlier sessions) blocks
  nothing. Leave it alone; the user can clear those files in Desktop later.
- **Loaded = title shows the file name + CPU quiet for 20 s.** Saving earlier can save
  a half-loaded report.
- **Saved = format changed (Convert) or files written after the click (Resave), then
  10 s with no writes.** Closing earlier can cut the save short.
- **One Desktop at a time.** The script refuses to start if Desktop is already open.

## Steps

1. **Ask** which folder, and whether it's a conversion (default) or a plain re-save
   (`-Mode Resave`; add `-IncludePbix` for .pbix files, `-Recurse` for subfolders).
2. **Check** it's on a branch, not `main`, with a clean `git status` (so the diff
   shows only Desktop's changes). For PBIP repos, make sure `.gitignore` has
   `**/.pbi/localSettings.json` and `**/.pbi/cache.abf`.
3. **List** (opens nothing):
   ```powershell
   powershell -ExecutionPolicy Bypass -File "<skill>\scripts\Save-PowerBIFiles.ps1" -Path "<folder>" -List
   ```
4. **Trial one file**: `-First 1`. Ask the user to close Power BI Desktop first.
   Check the result (log row, `git status`) before the rest.
5. **Run the rest** with no `-First`. Run it in a **terminal tab the user can see**
   (the terminal tool's run_in_terminal, or ask them to run it), not a hidden
   background shell: a file may need a hand save, and the script then waits for them.
   Tell the user they can keep working but must leave Desktop alone.
   Use `-NoPrompt` only when no one will be there to answer "continue?".
6. **Report** from the log (`%LOCALAPPDATA%\PbiBatchSave\<folder>-log.csv`, appended
   across runs): name, status, steps (`saved by script; closed by script` or
   `finished by hand`), visuals before/after. For a conversion, PBIR `visual.json`
   count should equal report.json's visual count.
7. **Review the diff with the user before committing** (see below). Never commit,
   push or merge without being asked.

Re-running is safe: in Convert mode, reports already in PBIR are skipped.

## What Desktop changes besides the conversion

Check these in `git diff` and tell the user; offer to tidy them before committing:

- **Line endings.** Desktop writes CRLF. Repos synced from the Fabric service store LF.
  Many existing files then show as modified with no real change, and the next commit
  from the service flips every file back to LF. Fix: add `.gitattributes` with
  `* text=auto eol=lf` (check what the repo uses first; `git diff --ignore-cr-at-eol`
  or `git diff -w --stat` shows which changes are line endings only).
- **Q&A synonyms.** `cultures/<locale>.tmdl` gains/loses `PowerBI.VisualColumnRename`
  "Suggested" synonyms, recalculated from the visuals. Unrelated to the conversion;
  offer to restore the file (`git checkout -- <file>`).
- **`.pbi/localSettings.json`, `.pbi/cache.abf`**: local-only; must be ignored, never committed.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Desktop is already running" | Ask the user to save and close it. |
| Never finishes loading | A sign-in or permission dialog is open; the script lists Desktop's windows and buttons. The user answers it, saves, closes. |
| Saved but not converted | Older Desktop: turn on PBIR under File > Options > Preview features. Desktop builds from 2026 convert on save. |
| Stays open after Close | A "save changes?" or other dialog. The script lists the buttons. The user picks Save, never Don't save. |
| Desktop not found | Pass `-DesktopExe "<path>\PBIDesktop.exe"` (default: the Store launcher, then Program Files). |
| Resave says "no change written" | Desktop had nothing to save (file already current). Not an error. |

## After a conversion

PBIR is one-way in practice. Mention: tools that read `report.json` must read
`definition/` instead; a converted repo has thousands of files (one per visual), so
long paths and big first PRs are normal; the workspace owner should know before the
change reaches the workspace through Git integration.
