<#
.SYNOPSIS
    Opens Power BI files in a folder in Power BI Desktop one at a time, saves each and
    closes Desktop, then checks and logs the result.

.DESCRIPTION
    Power BI Desktop has no command-line save or convert. This script drives Desktop the
    way a person would, one file at a time:

      1. Finds the files to do (see -Mode), smallest first.
      2. For each: opens it in Desktop, waits until Desktop has finished loading (window
         title shows the file's name and CPU has been quiet for 20 s), clicks Desktop's own
         Save button through UI Automation, waits until the save has been written, clicks
         Desktop's own Close button (dismissing a feature pop-up first if one is in the
         way), and waits for Desktop to exit.
      3. Checks the result, appends it to the log and prints a summary.

    UI Automation clicks work while Desktop is behind other windows, so the user can keep
    working; they just shouldn't touch Desktop. Ctrl+S is only a fallback, and keys are
    sent only after checking Desktop's window really is in front. If anything doesn't go
    as expected (a dialog, no save, Desktop won't close) the script lists Desktop's open
    windows and buttons and waits for the user to finish that file by hand.

    Desktop's "View recovered files" banner doesn't block saving or closing; it's left
    alone. The script never commits, pushes, deletes or kills anything.

    Modes
      Convert  (default) PBIP reports still in PBIR-Legacy format (report.json). Saving
               converts them to PBIR (definition\pages\...\visual.json). Verified by the
               format change.
      Resave   Every PBIP report (definition.pbir) in the folder, plus .pbix files with
               -IncludePbix. Verified by Desktop writing files after the save.

.PARAMETER Path
    The folder to work in (a PBIP repo or any folder holding Power BI files).

.PARAMETER Mode
    Convert (default) or Resave. See above.

.PARAMETER Recurse
    Also look in subfolders (default: only *.Report folders / .pbix files directly in -Path).

.PARAMETER IncludePbix
    Resave mode: include .pbix files.

.PARAMETER First
    Only do the first N files (smallest first). -First 1 is a trial run.

.PARAMETER Only
    Only these, by name without ".Report" / ".pbix". Accepts -Only "A","B" or -Only "A,B".

.PARAMETER List
    Show what would be done, and stop. Opens nothing.

.PARAMETER Manual
    Don't save or close automatically; wait while the user does it.

.PARAMETER NoPrompt
    Don't ask whether to continue after a file that didn't save or convert; carry on.

.PARAMETER LoadTimeoutMinutes
    How long to wait for a file to finish loading before asking for a hand save.

.PARAMETER LogPath
    CSV log, appended across runs. Default: %LOCALAPPDATA%\PbiBatchSave\<folder name>-log.csv

.PARAMETER DesktopExe
    Desktop to start. Default: the Microsoft Store launcher, else PBIDesktop.exe under
    Program Files.

.EXAMPLE
    .\Save-PowerBIFiles.ps1 -Path C:\repos\my_workspace -List
.EXAMPLE
    .\Save-PowerBIFiles.ps1 -Path C:\repos\my_workspace -First 1
.EXAMPLE
    .\Save-PowerBIFiles.ps1 -Path C:\reports -Mode Resave -IncludePbix -Recurse
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [ValidateSet('Convert', 'Resave')][string]$Mode = 'Convert',
    [switch]$Recurse,
    [switch]$IncludePbix,
    [int]$First = 0,
    [string[]]$Only = @(),
    [switch]$List,
    [switch]$Manual,
    [switch]$NoPrompt,
    [int]$LoadTimeoutMinutes = 15,
    [string]$LogPath = '',
    [string]$DesktopExe = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace PbiBatchSave -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]

# ---------------------------------------------------------------- Desktop / UI Automation

function Find-Button($element, [string]$name) {
    $element.FindFirst($T::Descendants, (New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
        (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name)))))
}

function Invoke-Button($btn) {
    $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Get-DesktopProcess {
    # The Desktop process that owns a main window (the splash screen and helpers don't).
    Get-Process -Name PBIDesktop -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
}

function Wait-DesktopIdle([string]$name, [int]$timeoutMinutes) {
    # Loaded = main window title shows the file's name and CPU stayed low for 4 x 5 s.
    $deadline = (Get-Date).AddMinutes($timeoutMinutes)
    $quiet = 0; $lastCpu = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        $p = Get-DesktopProcess
        if (-not $p) { $quiet = 0; continue }
        $p.Refresh()
        $cpu = $p.TotalProcessorTime.TotalSeconds
        $titled = $p.MainWindowTitle -like "*$name*"
        if ($titled -and $null -ne $lastCpu -and ($cpu - $lastCpu) -lt 0.5) { $quiet++ } else { $quiet = 0 }
        $lastCpu = $cpu
        if ($quiet -ge 4) { return $p }
    }
    return $null
}

function Invoke-SaveButton($proc) {
    # Desktop's own Save button: works while Desktop is behind other windows.
    try {
        $btn = Find-Button ($A::FromHandle($proc.MainWindowHandle)) 'Save'
        if ($btn) { Invoke-Button $btn; return $true }
    } catch { }
    return $false
}

function Send-SaveKeys($proc) {
    # Fallback: Ctrl+S, only once Desktop's window is really in front. Windows refuses
    # SetForegroundWindow while the user is busy in another window, hence the check.
    for ($try = 0; $try -lt 5; $try++) {
        [void][PbiBatchSave.Win32]::ShowWindow($proc.MainWindowHandle, 9)
        [void][PbiBatchSave.Win32]::SetForegroundWindow($proc.MainWindowHandle)
        Start-Sleep -Milliseconds 700
        $fg = [PbiBatchSave.Win32]::GetForegroundWindow(); [uint32]$fgPid = 0
        [void][PbiBatchSave.Win32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
        if ($fgPid -eq $proc.Id) { [System.Windows.Forms.SendKeys]::SendWait('^s'); return $true }
    }
    return $false
}

function Close-DesktopWindow([string]$name) {
    # Desktop ignores a plain close request to its process but responds to its own
    # Close (X) button. A feature pop-up ("Try it now") blocks closing; its
    # "Close Dialog" button is clicked first.
    foreach ($id in @(Get-Process -Name PBIDesktop -ErrorAction SilentlyContinue | ForEach-Object Id)) {
        $wins = @($A::RootElement.FindAll($T::Children,
            (New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $id))))
        $win = @($wins | Where-Object { $_.Current.Name -like "*$name*" }) + $wins | Select-Object -First 1
        if (-not $win) { continue }
        $popup = Find-Button $win 'Close Dialog'
        if ($popup) {
            Invoke-Button $popup
            Start-Sleep -Seconds 2
            $win = $A::FromHandle((Get-Process -Id $id).MainWindowHandle)
        }
        $btn = Find-Button $win 'Close'
        if ($btn) { Invoke-Button $btn; return $true }
    }
    return $false
}

function Show-DesktopWindows {
    # What is Desktop waiting for? List its windows and their last buttons.
    foreach ($id in @(Get-Process -Name PBIDesktop -ErrorAction SilentlyContinue | ForEach-Object Id)) {
        $cond = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $id)
        foreach ($win in $A::RootElement.FindAll($T::Children, $cond)) {
            try {
                $buttons = $win.FindAll($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition(
                    $A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
                $names = @($buttons | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Select-Object -Last 15)
                Write-Host ("    Window '{0}'  buttons: {1}" -f $win.Current.Name, ($names -join ' / '))
            } catch { }
        }
    }
}

function Wait-DesktopExit {
    while (Get-Process -Name PBIDesktop -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 3 }
}

# ---------------------------------------------------------------- Files and their state

function Get-NewestWrite([string[]]$paths) {
    $newest = $null
    foreach ($p in $paths) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $item = Get-Item -LiteralPath $p
        $files = if ($item.PSIsContainer) {
            Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -notmatch '\\\.pbi\\(cache\.abf|localSettings\.json)$' }
        } else { @($item) }
        $f = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($f -and (-not $newest -or $f.LastWriteTime -gt $newest)) { $newest = $f.LastWriteTime }
    }
    return $newest
}

function Get-ModelFolder([string]$pbirFile) {
    # The semantic model a PBIP report points at (datasetReference.byPath), if local.
    try {
        $ref = (Get-Content -LiteralPath $pbirFile -Raw | ConvertFrom-Json).datasetReference.byPath.path
        if ($ref) {
            $full = [System.IO.Path]::GetFullPath((Join-Path (Split-Path $pbirFile) $ref))
            if (Test-Path -LiteralPath $full) { return $full }
        }
    } catch { }
    return $null
}

function Get-ItemState($entry) {
    if ($entry.Kind -eq 'pbix') {
        $f = Get-Item -LiteralPath $entry.File
        return [pscustomobject]@{ Legacy = $false; Pbir = $false; Visuals = $null; Written = $f.LastWriteTime }
    }
    $legacy = Test-Path -LiteralPath (Join-Path $entry.Folder 'report.json')
    $pbir = Test-Path -LiteralPath (Join-Path $entry.Folder 'definition\pages')
    $visuals = if ($pbir) { @(Get-ChildItem -LiteralPath (Join-Path $entry.Folder 'definition') -Recurse -Filter 'visual.json' -File).Count } else { 0 }
    [pscustomobject]@{ Legacy = $legacy; Pbir = $pbir; Visuals = $visuals; Written = (Get-NewestWrite $entry.Watch) }
}

function Get-LegacyVisualCount([string]$reportJson) {
    try {
        $doc = Get-Content -LiteralPath $reportJson -Raw -Encoding UTF8 | ConvertFrom-Json
        $n = 0; foreach ($s in @($doc.sections)) { $n += @($s.visualContainers).Count }; return $n
    } catch { return -1 }
}

function Wait-Saved($entry, [datetime]$since, [int]$timeoutMinutes) {
    # Saved = (Convert) the report is PBIR and report.json is gone, or (Resave) something
    # was written after the click; and nothing has been written for 10 s since.
    $deadline = (Get-Date).AddMinutes($timeoutMinutes)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $s = Get-ItemState $entry
        $ok = if ($Mode -eq 'Convert') { $s.Pbir -and -not $s.Legacy } else { $s.Written -and $s.Written -gt $since }
        if ($ok -and ((Get-Date) - $s.Written).TotalSeconds -ge 10) { return $true }
    }
    return $false
}

function Invoke-Git {
    # Windows PowerShell turns git's stderr into a terminating error under 'Stop'; a
    # folder that isn't a repo is fine here, so ignore it.
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & git @args 2>$null } catch { } finally { $ErrorActionPreference = $old }
}

# ---------------------------------------------------------------- Find the work

if (-not (Test-Path -LiteralPath $Path)) { throw "Folder not found: $Path" }
$Path = (Resolve-Path -LiteralPath $Path).Path
$depth = @{}; if (-not $Recurse) { $depth = @{ Depth = 0 } }

$entries = New-Object System.Collections.Generic.List[object]
Get-ChildItem -LiteralPath $Path -Directory -Filter '*.Report' -Recurse:$Recurse @depth |
    Where-Object { $_.FullName -notmatch '\\\.git\\' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'definition.pbir')) } |
    ForEach-Object {
        $pbir = Join-Path $_.FullName 'definition.pbir'
        $watch = @($_.FullName); $model = Get-ModelFolder $pbir; if ($model) { $watch += $model }
        $e = [pscustomobject]@{ Kind = 'pbip'; Name = ($_.Name -replace '\.Report$', ''); Folder = $_.FullName
                                File = $pbir; Watch = $watch; Size = 0 }
        $st = Get-ItemState $e
        $e.Size = if ($st.Legacy) { Get-LegacyVisualCount (Join-Path $_.FullName 'report.json') } else { $st.Visuals }
        $e | Add-Member -NotePropertyName State -NotePropertyValue $st -PassThru
    } | ForEach-Object { $entries.Add($_) }

if ($IncludePbix) {
    Get-ChildItem -LiteralPath $Path -File -Filter '*.pbix' -Recurse:$Recurse @depth | ForEach-Object {
        $e = [pscustomobject]@{ Kind = 'pbix'; Name = $_.BaseName; Folder = $_.DirectoryName; File = $_.FullName
                                Watch = @($_.FullName); Size = [math]::Round($_.Length / 1MB, 1) }
        $e | Add-Member -NotePropertyName State -NotePropertyValue (Get-ItemState $e) -PassThru
    } | ForEach-Object { $entries.Add($_) }
}

$all = $entries.ToArray()  # @() on a generic List throws "Argument types do not match" in Windows PowerShell
$candidates = if ($Mode -eq 'Convert') { @($all | Where-Object { $_.Kind -eq 'pbip' -and $_.State.Legacy }) } else { $all }
$todo = @($candidates | Sort-Object Kind, Size)
if ($Only.Count -gt 0) {
    $Only = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().Trim('"', "'") } | Where-Object { $_ })
    $missing = $Only | Where-Object { $_ -notin $entries.Name }
    if ($missing) { throw "Nothing named: $($missing -join ', ')" }
    $todo = @($todo | Where-Object { $_.Name -in $Only })
}
if ($First -gt 0) { $todo = @($todo | Select-Object -First $First) }

Write-Host ""
Write-Host "Folder: $Path   Mode: $Mode"
$pbipCount = @($entries | Where-Object Kind -eq 'pbip').Count
$legacyCount = @($entries | Where-Object { $_.Kind -eq 'pbip' -and $_.State.Legacy }).Count
$pbixNote = if ($IncludePbix) { "   .pbix files: $(@($entries | Where-Object Kind -eq 'pbix').Count)" } else { '' }
Write-Host (("PBIP reports: {0} ({1} PBIR-Legacy, {2} PBIR)" -f $pbipCount, $legacyCount, ($pbipCount - $legacyCount)) + $pbixNote)
$branch = (Invoke-Git -C $Path branch --show-current)
if ($branch) {
    Write-Host "Git branch: $branch"
    if ($branch -in @('main', 'master')) { Write-Warning "You're on $branch. Create a branch first, e.g. git -C `"$Path`" switch -c dev/desktop-resave" }
}
Write-Host ""
if ($todo.Count -eq 0) { Write-Host "Nothing to do."; return }

Write-Host "To do now (smallest first):"
$todo | Format-Table @{n='Name';e={$_.Name}}, @{n='Kind';e={$_.Kind}},
    @{n='Size';e={ if ($_.Kind -eq 'pbix') { "$($_.Size) MB" } else { "$($_.Size) visuals" } }} -AutoSize | Out-Host
if ($List) { return }

# ---------------------------------------------------------------- Run

if (-not $DesktopExe) {
    $DesktopExe = @((Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\PBIDesktopStore.exe'),
                    (Join-Path $env:ProgramFiles 'Microsoft Power BI Desktop\bin\PBIDesktop.exe')) |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $DesktopExe -or -not (Test-Path -LiteralPath $DesktopExe)) {
    throw "Power BI Desktop not found. Pass -DesktopExe with the path to PBIDesktop.exe."
}
if (Get-Process -Name PBIDesktop -ErrorAction SilentlyContinue) {
    throw "Power BI Desktop is already running. Save your work and close it, then run this again."
}
if (-not $LogPath) {
    $dir = Join-Path $env:LOCALAPPDATA 'PbiBatchSave'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $LogPath = Join-Path $dir ((Split-Path $Path -Leaf) + '-log.csv')
}
if (-not $Manual) {
    Write-Host "Saving and closing automatically. Keep using other windows if you like, but leave Power BI Desktop alone. Ctrl+C here stops." -ForegroundColor Yellow
}

$results = New-Object System.Collections.Generic.List[object]
if (Test-Path -LiteralPath $LogPath) { try { Import-Csv -LiteralPath $LogPath | ForEach-Object { $results.Add($_) } } catch { } }

$i = 0
foreach ($e in $todo) {
    $i++
    Write-Host ""
    Write-Host ("[{0}/{1}] {2}  ({3})" -f $i, $todo.Count, $e.Name, $e.Kind) -ForegroundColor Cyan
    $started = Get-Date
    $actions = @()
    Start-Process -FilePath $DesktopExe -ArgumentList ('"{0}"' -f $e.File) | Out-Null

    # The Store launcher returns at once; wait for Desktop itself.
    $deadline = (Get-Date).AddMinutes(5)
    while (-not (Get-Process -Name PBIDesktop -ErrorAction SilentlyContinue)) {
        if ((Get-Date) -gt $deadline) { throw "Power BI Desktop didn't start within 5 minutes." }
        Start-Sleep -Seconds 2
    }

    $closedByScript = $false
    if (-not $Manual) {
        Write-Host "  Waiting for Desktop to finish loading..."
        $proc = Wait-DesktopIdle $e.Name $LoadTimeoutMinutes
        $clicked = Get-Date
        if (-not $proc) {
            Write-Warning "  Desktop didn't finish loading within $LoadTimeoutMinutes minutes, or its window doesn't show '$($e.Name)'. A dialog may be open."
            Show-DesktopWindows
        } elseif (-not ((Invoke-SaveButton $proc) -or (Send-SaveKeys $proc))) {
            Write-Warning "  Couldn't find Desktop's Save button or bring its window to the front; nothing was saved."
        } else {
            $actions += 'saved by script'
            Write-Host "  Saved. Waiting for Desktop to finish writing..."
            $wait = if ($Mode -eq 'Convert') { 10 } else { 3 }
            if (Wait-Saved $e $clicked $wait) {
                Write-Host "  Closing Desktop..."
                if (-not (Close-DesktopWindow $e.Name)) { Write-Warning "  Couldn't find Desktop's Close button." }
                $closeBy = (Get-Date).AddMinutes(3)
                while ((Get-Process -Name PBIDesktop -ErrorAction SilentlyContinue) -and (Get-Date) -lt $closeBy) { Start-Sleep -Seconds 3 }
                if (Get-Process -Name PBIDesktop -ErrorAction SilentlyContinue) {
                    Write-Warning "  Desktop is still open (a dialog may be asking something). Close it by hand; don't discard the save."
                    Show-DesktopWindows
                } else { $closedByScript = $true; $actions += 'closed by script' }
            } else {
                Write-Warning ("  No save written within {0} minutes. {1}" -f $wait,
                    $(if ($Mode -eq 'Convert') { 'A dialog may be open, or this Desktop may not convert to PBIR on save.' } else { 'Desktop may have had nothing to save, or a dialog is open.' }))
                Show-DesktopWindows
            }
        }
        if (-not $closedByScript) { Write-Host "  Finish this one by hand: answer any dialog, press Ctrl+S, then close Desktop." -ForegroundColor Yellow }
    } else {
        Write-Host "  When Desktop has loaded: press Ctrl+S (no data refresh needed), then close Desktop."
    }
    Write-Host "  Continuing when Desktop closes."
    Wait-DesktopExit

    $after = Get-ItemState $e
    $status = if ($Mode -eq 'Convert') {
        if ($after.Pbir -and -not $after.Legacy) { 'converted' } elseif ($after.Pbir) { 'both formats present' } else { 'not converted' }
    } else {
        if ($after.Written -and $after.Written -gt $started) { 'saved' } else { 'no change written' }
    }
    $results.Add([pscustomobject]@{
        Folder   = $Path
        Name     = $e.Name
        Kind     = $e.Kind
        Mode     = $Mode
        Status   = $status
        Steps    = $(if ($Manual) { 'manual' } elseif ($closedByScript) { $actions -join '; ' } else { (@($actions) + 'finished by hand') -join '; ' })
        Before   = $e.Size
        Visuals  = $after.Visuals
        Minutes  = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
        Finished = (Get-Date).ToString('s')
    })
    $results | Export-Csv -LiteralPath $LogPath -NoTypeInformation -Encoding UTF8

    if ($status -in @('converted', 'saved')) {
        $detail = if ($Mode -eq 'Convert') { " $($after.Visuals) visual.json files (report.json had $($e.Size) visuals)." } else { '' }
        Write-Host "  $($status.Substring(0,1).ToUpper())$($status.Substring(1)).$detail" -ForegroundColor Green
    } else {
        Write-Warning "  $($e.Name): $status."
        if ($Mode -eq 'Convert') { Write-Host "  If Desktop didn't convert on save, turn on PBIR under File > Options > Preview features (older Desktop builds) and save again." }
        if (-not $NoPrompt) {
            $answer = Read-Host "  Continue with the next one? (y/n)"
            if ($answer -notmatch '^[yY]') { break }
        }
    }
}

Write-Host ""
Write-Host "Summary (log: $LogPath):"
$results | Where-Object { $_.Folder -eq $Path -or -not $_.Folder } | Format-Table Name, Kind, Mode, Status, Steps, Before, Visuals, Minutes -AutoSize | Out-Host

$unignored = Invoke-Git -C $Path status --porcelain --untracked-files=all | Where-Object { $_ -match '\.pbi/(cache\.abf|localSettings\.json)' }
if ($unignored) {
    Write-Warning "These local Desktop files aren't ignored by Git; don't commit them (add **/.pbi/localSettings.json and **/.pbi/cache.abf to .gitignore):"
    $unignored | ForEach-Object { Write-Host "    $_" }
}
if ($Mode -eq 'Convert') {
    $remaining = @(Get-ChildItem -LiteralPath $Path -Directory -Filter '*.Report' -Recurse:$Recurse @depth |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'report.json') }).Count
    if ($remaining -gt 0) { Write-Host "$remaining report(s) still PBIR-Legacy. Run again to continue where you left off." }
    else { Write-Host "All reports are PBIR. Next: review 'git status', then commit on a branch." }
}
