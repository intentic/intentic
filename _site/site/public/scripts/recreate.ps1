<#
.SYNOPSIS
  intentic recreate (Windows): a bootstrap shim. The flow itself (update/rebuild/rollback, env replay, overlay
  re-base, the run command the image emits) lives in the `ic` CLI (_sandbox/ic); this script only finds or downloads
  the binary and forwards the parameter shapes the platform's cards hand out: -Slug alone = update, -Slug + -Hash =
  rebuild (the SHA256 is the trust anchor - only overlay content that still hashes to what the owner
  reviewed is ever built), -Slug + -Rollback = back to the image it ran before its last update, and
  -Slug + -Prepare = download and build the next update without applying it, and -Slug + -Reshape <ic flags> =
  the same image with a different share of this device (--memory/--cpus/--privileged/--gpus are ic's own
  flags, forwarded verbatim after -Reshape). -Slug + -Shape <ic flags> sets a shape now or for the next restart
  (`ic sandbox shape`), -Slug + -Start/-Stop/-Restart powers it through ic (a saved shape is applied), and -List
  alone prints every sandbox here as JSON. -Slug + -RollbackTo <version|image> goes back to an older version this
  device kept, and -Slug + -Versions lists those. -Slug + -Watch finishes or undoes a swap that was cut off and
  judges a new version on probation, -Slug + -Backup backs the sandbox's data up now, and -Slug + -Doctor names
  what stands between you and the sandbox, with the fix. -Slug + -Remove moves it to ic's trash: its /work and
  /history stay recoverable for a week (`ic sandbox restore`).

.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/update))) -Slug abc123        # update
.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/rebuild))) -Slug abc123 -Hash <sha256>   # rebuild
.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/update))) -Slug abc123 -Rollback   # roll back
.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/update))) -Slug abc123 -Prepare    # download it now
.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/update))) -Slug abc123 -Reshape --memory 12g --cpus 4
.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/update))) -Slug abc123 -RollbackTo 1.200.0   # an older version

  The script never ends the PowerShell it runs in: under irm | iex it returns with the code in $LASTEXITCODE, and only
  a run as a file (powershell -File, how the desktop app runs it) exits with it.

.EXAMPLE
  irm https://intentic.dev/update/<slug> | iex             # the same, by verb: /rollback/<slug>, /restart/<slug>,
                                                           # /rebuild/<slug>/<sha256>
#>
param(
    # Required by every mode but -List. Not Mandatory: PowerShell would PROMPT for a missing one, and the desktop app
    # that runs this has nobody to answer; the check below refuses instead.
    [string]$Slug,
    # Present => rebuild (the approved overlay, pinned to this digest); absent => update (the fresh base).
    [string]$Hash,
    # The third way through the same shim, matching recreate.sh's --rollback: the image before the last update.
    # A switch rather than a value, so it can never be confused with the digest above.
    [switch]$Rollback,
    # Matching recreate.sh's --rollback-to: an older version than that, among those this device kept (-Versions
    # lists them). A value, named, so it binds nowhere else. -Rollback still means exactly -Rollback: an exact
    # parameter name always wins over one it is the prefix of.
    [string]$RollbackTo,
    # The versions this sandbox can go back to, matching recreate.sh's --versions. Read-only.
    [switch]$Versions,
    # The fourth, matching recreate.sh's --prepare: download and build the next update and stop there. The
    # container is never touched, so this is safe to run while the sandbox is being used.
    [switch]$Prepare,
    # The fifth, matching recreate.sh's --reshape: the same image, a different share of this device. What
    # follows the switch is ic's own flag surface (--memory 12g, --cpus 4, --privileged on, --gpus off),
    # captured whole and forwarded verbatim so this shim never learns a flag ic could add later.
    [switch]$Reshape,
    # The same, for ic's `shape` verb (the four fields and --when, or --forget), forwarded verbatim.
    [switch]$Shape,
    # Power through ic, matching recreate.sh's --start/--stop/--restart: a start or restart applies a saved shape.
    [switch]$Start,
    [switch]$Stop,
    [switch]$Restart,
    # Matching recreate.sh's --watch: finish or undo a swap that was cut off, and judge a new version on probation
    # (ic rolls it back by itself if it keeps crashing, never becomes ready, or loses its tunnel).
    [switch]$Watch,
    # Matching recreate.sh's --backup and --doctor: back the sandbox's data up now; name what stands between you
    # and the sandbox, with the fix (read-only).
    [switch]$Backup,
    [switch]$Doctor,
    # Matching recreate.sh's --remove: into ic's trash, never deleted on the spot: /work and /history stay
    # recoverable for a week (`ic sandbox restore`). Unasked (-y), because whoever runs this has already been asked:
    # the desktop app's Remove confirms first.
    [switch]$Remove,
    # Every sandbox on this device as JSON (`ic sandbox list --json`): the desktop app's listing when the installed
    # ic is older than the app, since this fetch brings it level.
    [switch]$List,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ReshapeArgs
)

$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# >>> generated from _site/site/scripts-kit/kit.ps1: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# The shim kit: the protocol's shapes (docs/ops/cli-output-protocol.md) for the few lines a script prints before it
# hands over to ic or intentic-machine, which draw everything after that themselves. Windows PowerShell 5.1 and pwsh 7.
#
# PURE ASCII, as every .ps1 here must be: 5.1 reads a BOM-less file in the ANSI code page. The glyphs are built from
# their code points instead.
#
#   Invoke-IntenticScript { ... }            runs the script's body; the ONLY place a script ends. See below.
#   Write-IntenticBegin <what> [scope]       the header; rich only, and only in a script that draws a whole flow
#   Write-IntenticStep <phase> <sentence> <label>
#                                            a step; plain prints `intentic: [<phase>] <sentence>` (no phase: narration)
#   Write-IntenticSay <sentence>             narration under the running step
#   Write-IntenticWarn <sentence>            a caution: degraded, not broken (stderr in plain)
#   Suspend-IntenticLine / Resume-IntenticLine
#                                            hand the screen to a command that prints its own lines, and take it back
#   Complete-IntenticStep                    the running step is done
#   Write-IntenticFinished <verdict> [address]
#   Write-IntenticLater <what>, <command>, ...  the later footnotes under a verdict; rich only
#   Stop-Intentic <headline> [problem] [fix] [code]
#                                            the running step settles as failed, the stop block goes to stderr, and
#                                            the script ends with the code (1 unless given; 2 for a wrong command line)
#   Read-IntenticConfirm <question> <consequence> <flag>
#                                            [y/N]: $true on yes; on no it says so and returns $false (the caller
#                                            returns, exit code 0); nobody there is a stop naming the flag that answers
#   Set-IntenticExit <code>                  the code the script ends with, when it is not 0 (a handover's own)
#
# WHY NO SCRIPT CALLS `exit`. Under `irm ... | iex`, and inside the `& { ... }` the site's Worker wraps a script in,
# `exit` ends the person's whole PowerShell process, and the window can close on the one line that said what went
# wrong. Invoke-IntenticScript runs the body, catches a stop, leaves the code in $LASTEXITCODE, and exits only when the
# script runs as a file (`powershell -File`, how the desktop app runs these), where exiting is how the code gets out.

$IntenticKit = @{ Mode = 'plain'; Color = $false; Label = ''; Open = $false; Clock = $null; Code = 0; Width = 80 }
if ($env:INTENTIC_UI -eq 'rich' -or $env:INTENTIC_UI -eq 'plain' -or $env:INTENTIC_UI -eq 'nested') {
    $IntenticKit.Mode = $env:INTENTIC_UI
} elseif ($env:INTENTIC_PLAIN -ne '1' -and -not [Console]::IsOutputRedirected) {
    $IntenticKit.Mode = 'rich'
}
$IntenticKit.Color = $IntenticKit.Mode -eq 'rich' -and ($env:FORCE_COLOR -or -not $env:NO_COLOR)
# Unicode where the console can draw it: pwsh, Windows Terminal, or a console host that took VT processing. The old
# console with a raster font cannot, and gets ASCII.
$IntenticUnicode = $PSVersionTable.PSVersion.Major -ge 6 -or [bool]$env:WT_SESSION
if (-not $IntenticUnicode) { try { $IntenticUnicode = [bool]$Host.UI.SupportsVirtualTerminal } catch { $IntenticUnicode = $false } }
if ($IntenticUnicode) {
    $IntenticKit.Ok = [string][char]0x2713; $IntenticKit.Fail = [string][char]0x2717; $IntenticKit.Skip = [string][char]0x00B7
    $IntenticKit.Run = [string][char]0x2839; $IntenticKit.More = [string][char]0x2026; $IntenticKit.Dot = [string][char]0x00B7
} else {
    $IntenticKit.Ok = '+'; $IntenticKit.Fail = 'x'; $IntenticKit.Skip = '-'; $IntenticKit.Run = '|'; $IntenticKit.More = '...'; $IntenticKit.Dot = '-'
}
try { if ($Host.UI.RawUI.WindowSize.Width -gt 20) { $IntenticKit.Width = [Math]::Min(100, $Host.UI.RawUI.WindowSize.Width) } } catch { $IntenticKit.Width = 80 }

# One run of text, coloured when colour is on, never ending the line.
function Write-IntenticRun {
    param([string]$Text, [string]$Color = '')
    if ($IntenticKit.Color -and $Color) { Write-Host $Text -NoNewline -ForegroundColor $Color } else { Write-Host $Text -NoNewline }
}

function Write-IntenticLive {
    Write-Host '  ' -NoNewline
    Write-IntenticRun $IntenticKit.Run 'Cyan'
    Write-Host "  $($IntenticKit.Label)$($IntenticKit.More)" -NoNewline
    $IntenticKit.Open = $true
}

function Clear-IntenticLive {
    if ($IntenticKit.Open) {
        Write-Host ("`r" + (' ' * ($IntenticKit.Width - 1)) + "`r") -NoNewline
        $IntenticKit.Open = $false
    }
}

# A whole line above the live one: the live line steps aside and comes back under it.
function Write-IntenticAbove {
    param([scriptblock]$Line)
    $wasOpen = $IntenticKit.Open
    Clear-IntenticLive
    & $Line
    Write-Host ''
    if ($wasOpen) { Write-IntenticLive }
}

function Format-IntenticDuration {
    param([TimeSpan]$Took)
    if ($Took.TotalSeconds -lt 10) { return ('{0:0.0}s' -f $Took.TotalSeconds) }
    if ($Took.TotalSeconds -lt 60) { return ('{0}s' -f [int][Math]::Floor($Took.TotalSeconds)) }
    return ('{0}m' -f [int][Math]::Floor($Took.TotalMinutes))
}

function Complete-IntenticStep {
    param([string]$Tone = 'ok')
    if (-not $IntenticKit.Label) { return }
    if ($IntenticKit.Mode -eq 'rich') {
        $took = Format-IntenticDuration $IntenticKit.Clock.Elapsed
        Clear-IntenticLive
        Write-Host '  ' -NoNewline
        switch ($Tone) {
            'fail' { Write-IntenticRun $IntenticKit.Fail 'Red' }
            'skip' { Write-IntenticRun $IntenticKit.Skip 'DarkGray' }
            default { Write-IntenticRun $IntenticKit.Ok 'Green' }
        }
        $pad = [Math]::Max(2, $IntenticKit.Width - 7 - $IntenticKit.Label.Length - $took.Length)
        Write-Host ("  " + $IntenticKit.Label + (' ' * $pad)) -NoNewline
        Write-IntenticRun $took 'DarkGray'
        Write-Host ''
    }
    $IntenticKit.Label = ''
}

function Write-IntenticBegin {
    param([string]$What, [string]$Scope = '')
    if ($IntenticKit.Mode -ne 'rich') { return }
    Write-Host ''
    Write-Host '  ' -NoNewline
    Write-IntenticRun "intentic $($IntenticKit.Dot) $What" 'White'
    Write-Host ''
    if ($Scope) {
        Write-Host '  ' -NoNewline
        Write-IntenticRun $Scope 'DarkGray'
        Write-Host ''
    }
    Write-Host ''
}

function Write-IntenticStep {
    param([string]$Phase, [string]$Sentence, [string]$Label)
    switch ($IntenticKit.Mode) {
        'plain' { if ($Phase) { Write-Host "intentic: [$Phase] $Sentence" } else { Write-Host "intentic: $Sentence" } }
        'nested' { Write-Host "        $Label" }
        default {
            Complete-IntenticStep 'ok'
            $IntenticKit.Label = $Label
            $IntenticKit.Clock = [Diagnostics.Stopwatch]::StartNew()
            Write-IntenticLive
        }
    }
}

function Write-IntenticSay {
    param([string]$Sentence)
    switch ($IntenticKit.Mode) {
        'plain' { Write-Host "intentic: $Sentence" }
        'nested' { Write-Host "        $Sentence" }
        default { Write-IntenticAbove { Write-Host '        ' -NoNewline; Write-IntenticRun $Sentence 'DarkGray' } }
    }
}

function Write-IntenticWarn {
    param([string]$Sentence)
    switch ($IntenticKit.Mode) {
        'plain' { [Console]::Error.WriteLine("intentic: $Sentence") }
        'nested' { Write-Host "     !  $Sentence" }
        default { Write-IntenticAbove { Write-Host '     ' -NoNewline; Write-IntenticRun '!' 'Yellow'; Write-Host '  ' -NoNewline; Write-IntenticRun $Sentence 'DarkGray' } }
    }
}

function Suspend-IntenticLine { if ($IntenticKit.Mode -eq 'rich') { Clear-IntenticLive } }

function Resume-IntenticLine { if ($IntenticKit.Mode -eq 'rich' -and $IntenticKit.Label -and -not $IntenticKit.Open) { Write-IntenticLive } }

function Write-IntenticFinished {
    param([string]$Verdict, [string]$Address = '')
    switch ($IntenticKit.Mode) {
        'plain' { Write-Host "intentic: $Verdict"; if ($Address) { Write-Host "intentic: $Address" } }
        'nested' { Write-Host "     $($IntenticKit.Ok)  $Verdict"; if ($Address) { Write-Host "        $Address" } }
        default {
            Complete-IntenticStep 'ok'
            Write-Host ''
            Write-Host '  ' -NoNewline
            Write-IntenticRun $IntenticKit.Ok 'Green'
            Write-Host '  ' -NoNewline
            Write-IntenticRun $Verdict 'White'
            Write-Host ''
            if ($Address) {
                Write-Host ''
                Write-Host '     ' -NoNewline
                Write-IntenticRun $Address 'Cyan'
                Write-Host ''
            }
            Write-Host ''
        }
    }
}

# The commands the reader will want later, as (what, command) pairs given flat: Write-IntenticLater 'stop it', 'ic ...'.
# Rich only: a log has no use for them.
function Write-IntenticLater {
    param([string[]]$Pairs)
    if ($IntenticKit.Mode -ne 'rich' -or $Pairs.Count -lt 2) { return }
    $column = 0
    for ($i = 0; $i -lt $Pairs.Count; $i += 2) { $column = [Math]::Max($column, $Pairs[$i].Length) }
    for ($i = 0; $i + 1 -lt $Pairs.Count; $i += 2) {
        $heading = if ($i -eq 0) { 'later' } else { '' }
        Write-Host '     ' -NoNewline
        Write-IntenticRun ('{0,-6} {1}' -f $heading, $Pairs[$i].PadRight($column)) 'DarkGray'
        Write-Host "   $($Pairs[$i + 1])"
    }
    Write-Host ''
}

function Write-IntenticCancelled {
    if ($IntenticKit.Mode -eq 'plain') { Write-Host 'intentic: Cancelled. Nothing changed.'; return }
    Complete-IntenticStep 'skip'
    Write-Host '  ' -NoNewline
    Write-IntenticRun "$($IntenticKit.Skip)  Cancelled. Nothing changed." 'DarkGray'
    Write-Host ''
}

# The stop block on stderr, then the sentinel Invoke-IntenticScript catches. Never called inside a try whose catch
# would swallow it.
function Stop-Intentic {
    param([string]$Headline, [string]$Problem = '', [string]$Fix = '', [int]$Code = 1)
    $err = [Console]::Error
    if ($IntenticKit.Mode -eq 'plain') {
        $err.WriteLine("error: $Headline")
        if ($Problem) { $err.WriteLine("   problem: $Problem") }
        if ($Fix) { $err.WriteLine("   fix:     $Fix") }
    } else {
        Complete-IntenticStep 'fail'
        $was = [Console]::ForegroundColor
        $err.WriteLine('')
        if ($IntenticKit.Color) { [Console]::ForegroundColor = 'Red' }
        $err.WriteLine("  $($IntenticKit.Fail)  $Headline")
        if ($IntenticKit.Color) { [Console]::ForegroundColor = $was }
        if ($Problem) { $err.WriteLine("     problem: $Problem") }
        if ($Fix) { $err.WriteLine("     fix:     $Fix") }
        $err.WriteLine('')
    }
    $IntenticKit.Code = $Code
    throw 'intentic:stop'
}

function Set-IntenticExit {
    param([int]$Code)
    $IntenticKit.Code = $Code
}

function Read-IntenticConfirm {
    param([string]$Question, [string]$Consequence, [string]$Flag)
    if ($env:INTENTIC_NO_PROMPT -ne '1' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        Suspend-IntenticLine
        if ($IntenticKit.Mode -eq 'rich') {
            Write-Host '  ' -NoNewline
            Write-IntenticRun '?' 'Cyan'
            Write-Host '  ' -NoNewline
            Write-IntenticRun $Question 'White'
            Write-Host ''
            foreach ($line in ($Consequence -split "`n")) { if ($line) { Write-Host '     ' -NoNewline; Write-IntenticRun $line 'DarkGray'; Write-Host '' } }
            $answer = Read-Host '     [y/N]'
        } else {
            Write-Host $Question
            if ($Consequence) { Write-Host $Consequence }
            $answer = Read-Host '[y/N]'
        }
        if ($answer -match '^\s*[yY]') {
            Resume-IntenticLine
            return $true
        }
        Write-IntenticCancelled
        return $false
    }
    Stop-Intentic 'Nothing was changed.' "nobody is at this terminal to answer: $Question" "run it again with $Flag"
}

function Invoke-IntenticScript {
    param([scriptblock]$Body)
    $IntenticKit.Code = 0
    try {
        & $Body
        Complete-IntenticStep 'ok'
    } catch {
        if ("$($_.Exception.Message)" -ne 'intentic:stop') {
            # Anything this script did not expect still ends in the protocol's stop block, never PowerShell's red one.
            $said = "$($_.Exception.Message)"
            try {
                Stop-Intentic 'The script stopped unexpectedly.' $said 'run the same command again; if it stops here again, report it with this message.'
            } catch {
                $IntenticKit.Code = 1
            }
        }
    }
    $global:LASTEXITCODE = $IntenticKit.Code
    if ($PSCommandPath) { exit $IntenticKit.Code }
}
# <<< end of generated kit.ps1

# >>> generated from _site/site/scripts-kit/add-path.ps1: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# THE FOLDER THE ic CLI LANDS IN, PUT ON THE USER'S PATH - so the commands ic prints when it finishes are real
# commands rather than a promise the installer that made them cannot keep. The .sh twin gets this free with a symlink
# into ~/.local/bin; Windows has no such folder, so the user's own PATH is the only place to say it.
#
# HKCU\Environment is written DIRECTLY rather than through [Environment]::SetEnvironmentVariable, which stores the
# value back as REG_SZ: every %USERPROFILE%- or %PNPM_HOME%-style entry already in that PATH would stop expanding, and
# each tool behind one would vanish from the user's shell. Reading with DoNotExpandEnvironmentNames keeps them as
# tokens, and the value goes back under the kind it already had.
#
# Best-effort: PATH is the convenience, the install is the job. A device that refuses the edit is told where the
# binary is and keeps everything else.
function Add-IntenticPath {
    param([string]$Folder, [string]$Command)
    try {
        $key = Get-Item -Path 'HKCU:\Environment' -ErrorAction Stop
        $stored = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if (($stored -split ';') -notcontains $Folder) {
            $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
            $kept = @($stored -split ';' | Where-Object { $_ -ne '' })
            Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value (($kept + $Folder) -join ';') -Type $kind -ErrorAction Stop
            # Explorer hands every terminal it starts a COPY of the environment, taken when Explorer itself
            # started. Without this broadcast - the one the Control Panel's environment editor sends - the new
            # PATH would reach nothing until the next sign-in. SendMessageTimeout, so one wedged window on this
            # desktop cannot wedge an install.
            if (-not ('Intentic.Native' -as [type])) {
                $signature = '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr word, string text, uint flags, uint timeout, out UIntPtr answer);'
                Add-Type -Namespace 'Intentic' -Name 'Native' -MemberDefinition $signature -ErrorAction Stop
            }
            $answer = [UIntPtr]::Zero
            [void][Intentic.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$answer)
        }
        # This window has its own copy as well, and it is the one the user is looking at when the output tells them
        # what to run next.
        if (($env:Path -split ';') -notcontains $Folder) { $env:Path = "$env:Path;$Folder" }
    } catch {
        Write-IntenticWarn "$Folder could not be added to your PATH ($($_.Exception.Message)), so $Command runs from that folder until you add it."
    }
}
# <<< end of generated add-path.ps1

# >>> generated from _site/site/scripts-kit/ic-fetch.ps1: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# Get-IntenticIc: the ic CLI to run, found or downloaded. IC_BIN overrides (a checkout's own build). Downloaded on
# every run that pins no release, so re-running a one-liner upgrades a device; a run pinned to a release (IC_VERSION)
# that finds it or a newer one installed skips it, and only a failed download falls back to an installed ic. Download-
# then-rename: overwriting a running executable fails, and a half-downloaded binary must never be what runs. A pinned
# run the desktop app started copies the ic the app carries (INTENTIC_IC_PATH) instead, when that one is exactly the
# release asked for.
function Get-IntenticIc {
    $Ic = $env:IC_BIN
    if ($Ic) { return $Ic }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $IcDir = "$env:USERPROFILE\.intentic\ic\bin"
    New-Item -ItemType Directory -Force -Path $IcDir | Out-Null
    $IcDest = "$IcDir\ic.exe"
    $IcBase = if ($env:IC_URL) { $env:IC_URL } else { 'https://github.com/intentic/intentic/releases/latest/download' }
    # Never "exactly that release": the machine agent moves ic up by itself, so a desktop app left in the tray for days
    # put an older ic back on every Start, Stop or Restart it ran (2026-10-05). Compared as versions, major.minor.patch
    # first, a pre-release below its own release; an installed ic whose answer is not a version is replaced.
    $IcHave = if ($env:IC_VERSION -and (Test-Path $IcDest)) { (& $IcDest --version | Out-String).Trim() } else { '' }
    $IcCurrent = $false
    if ($IcHave -match '^ic v?(\d+\.\d+\.\d+)(\S*)$') {
        $IcHaveCore = [version]$Matches[1]
        $IcHavePre = $Matches[2]
        if ($env:IC_VERSION -match '^v?(\d+\.\d+\.\d+)(\S*)$') {
            $IcPinCore = [version]$Matches[1]
            $IcCurrent = ($IcHaveCore -gt $IcPinCore) -or ($IcHaveCore -eq $IcPinCore -and (-not $IcHavePre -or $IcHavePre -eq $Matches[2]))
        }
    }
    if ($IcCurrent) {
        Write-IntenticSay "$IcHave is installed, and this run asks for ic $($env:IC_VERSION -replace '^v', '') or newer, so nothing is downloaded."
        $Ic = $IcDest
        Add-IntenticPath -Folder $IcDir -Command 'ic'
    } else {
        Write-IntenticStep 'fetching-ic' 'fetching the ic CLI...' 'Download ic'
        # THE ic THE DESKTOP APP CARRIES, copied instead of downloaded: a copy that answers exactly the pinned release is
        # the very binary the download would fetch, minus the network, so a device that cannot reach github.com still
        # gets its ic. Anything else leaves the download below to run, and that download is all the one-liner ever does.
        $IcCopied = $false
        if ($env:INTENTIC_IC_PATH -and $env:IC_VERSION -and (Test-Path -LiteralPath $env:INTENTIC_IC_PATH -PathType Leaf)) {
            $IcCarried = ''
            try { $IcCarried = (& $env:INTENTIC_IC_PATH --version | Out-String).Trim() } catch { $IcCarried = '' }
            if ($IcCarried -eq ('ic ' + ($env:IC_VERSION -replace '^v', ''))) {
                try {
                    Copy-Item -LiteralPath $env:INTENTIC_IC_PATH -Destination "$IcDest.tmp" -Force -ErrorAction Stop
                    Move-Item -Force "$IcDest.tmp" $IcDest -ErrorAction Stop
                    $IcCopied = $true
                } catch {
                    Remove-Item -Force "$IcDest.tmp" -ErrorAction SilentlyContinue
                }
            }
        }
        if ($IcCopied) {
            Write-IntenticSay "installed $IcCarried from the copy the desktop app carries."
            $Ic = $IcDest
            Add-IntenticPath -Folder $IcDir -Command 'ic'
        } else {
            # Windows PowerShell 5.1 redraws its progress bar for every chunk Invoke-WebRequest reads, which makes a
            # five-megabyte download take several seconds instead of a fraction of one.
            $ProgressPreference = 'SilentlyContinue'
            $IcFetched = $false
            try {
                Invoke-WebRequest -UseBasicParsing -Uri "$IcBase/ic-windows-amd64.exe" -OutFile "$IcDest.tmp" -ErrorAction Stop
                Move-Item -Force "$IcDest.tmp" $IcDest -ErrorAction Stop
                $IcFetched = $true
            } catch {
                Remove-Item -Force "$IcDest.tmp" -ErrorAction SilentlyContinue
            }
            if ($IcFetched) {
                $Ic = $IcDest
                Add-IntenticPath -Folder $IcDir -Command 'ic'
            } elseif (Test-Path $IcDest) {
                Write-IntenticWarn "the newest ic could not be downloaded, so the one installed at $IcDest runs instead."
                $Ic = $IcDest
            } else {
                $IcInstalled = Get-Command ic -ErrorAction SilentlyContinue
                if ($IcInstalled) {
                    Write-IntenticWarn "the newest ic could not be downloaded, so the one installed at $($IcInstalled.Source) runs instead."
                    $Ic = $IcInstalled.Source
                } else {
                    Stop-Intentic 'ic could not be downloaded, and no copy is installed.' "$(([uri]$IcBase).Host) did not answer from this device." 'check the network, then run the same command again.'
                }
            }
        }
        Complete-IntenticStep
    }
    return $Ic
}
# <<< end of generated ic-fetch.ps1

Invoke-IntenticScript {
    # A wrong command line costs nothing: refused before anything is downloaded, with exit code 2.
    if (-not $List -and -not $Slug) {
        Stop-Intentic 'Nothing was changed.' 'this command needs the sandbox it acts on.' 'run it again with -Slug <slug>' 2
    }

    $Ic = Get-IntenticIc
    Suspend-IntenticLine

    # recreate.sh reads only the first switch after the slug; here every switch binds, so the order below decides a
    # caller that passed two by mistake: read-only verbs first, and -Remove after every other named mode.
    # -Versions and -Watch forward what follows them verbatim (ic's --json), as recreate.sh does.
    $rest = @($ReshapeArgs | Where-Object { $_ })
    if ($List) {
        & $Ic sandbox list --json
    } elseif ($Versions) {
        & $Ic sandbox versions $Slug @rest
    } elseif ($Doctor) {
        & $Ic sandbox doctor $Slug
    } elseif ($Watch) {
        & $Ic sandbox watch $Slug @rest
    } elseif ($Backup) {
        & $Ic sandbox backup $Slug
    } elseif ($Start) {
        & $Ic sandbox start $Slug
    } elseif ($Stop) {
        & $Ic sandbox stop $Slug
    } elseif ($Restart) {
        & $Ic sandbox restart $Slug
    } elseif ($Shape) {
        & $Ic sandbox shape $Slug @rest
    } elseif ($RollbackTo) {
        & $Ic sandbox rollback $Slug --to $RollbackTo
    } elseif ($Rollback) {
        & $Ic sandbox rollback $Slug
    } elseif ($Prepare) {
        & $Ic sandbox prepare $Slug
    } elseif ($Reshape) {
        & $Ic sandbox reshape $Slug @rest
    } elseif ($Hash) {
        & $Ic sandbox rebuild $Slug $Hash
    } elseif ($Remove) {
        & $Ic sandbox remove $Slug -y
    } else {
        & $Ic sandbox update $Slug
    }
    Set-IntenticExit $LASTEXITCODE
}
