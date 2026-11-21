<#
.SYNOPSIS
  Bootstrap ic sandbox remove and translate legacy parameters. Data remains recoverable for seven days via ic sandbox restore.
  Under irm | iex return LASTEXITCODE without ending PowerShell; ic owns selection, prompts and output.
.PARAMETER Slug
  Sandboxes to remove; omit to let ic ask which.
.PARAMETER All
  Remove every sandbox on this device.
.PARAMETER Yes
  Confirm recoverable removal only; never permanent deletion.
.PARAMETER Now
  Permanently delete data after ic confirms the sandbox's name.
.PARAMETER AgentAuth
  Also remove shared dev agent logins.
.EXAMPLE
  irm https://intentic.dev/remove/<slug> | iex
#>
param(
    [string[]]$Slug,
    [switch]$All,
    [switch]$Yes,
    [switch]$Now,
    [switch]$AgentAuth,
    [switch]$Help
)

$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# >>> generated from _site/site/scripts-kit/kit.ps1: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# Bootstrap output helpers for PowerShell 5.1/7; see docs/ops/cli-output-protocol.md. Keep this file ASCII for BOM-less 5.1.
# Invoke-IntenticScript owns termination: direct exit under irm | iex would close the user's PowerShell session.
# Stops set LASTEXITCODE; only file execution exits the process. Read-IntenticConfirm returns false on refusal; callers must return.
# Suspend/resume the line around commands that draw their own output; ic or intentic-machine owns the display after handover.

$IntenticKit = @{ Mode = 'plain'; Color = $false; Label = ''; Step = ''; Open = $false; Clock = $null; Code = 0; Width = 80 }
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
    $IntenticKit.Step = ''
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
    # Kept in every mode, not only where a live line draws it: the unexpected stop below names the step it broke in.
    $IntenticKit.Step = if ($Label) { $Label } else { $Sentence }
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

# WHEN SECURITY SOFTWARE STANDS BETWEEN A SCRIPT AND ITS FILES (2026-11-20, intentic#49). On a PC whose endpoint
# security (Bitdefender Endpoint Security Tools, run from a company's console) takes Intentic's programs, a file it wrote
# a minute ago is listed and cannot be opened, run, moved or replaced: Windows answers "Access is denied" and nothing
# else. Said bare, that read as a fault of the script, and the one install that hit it reported a network failure
# instead. So a refusal is told apart wherever it can land, and the stop names the product and the folder to allow.
# Nothing here adds an exclusion: software that exempts itself from a scanner is what malware does, and scanners treat
# it so.

# The antivirus Windows Security Center lists as on, someone else's before Microsoft's own; '' where there is none to
# name (Windows Server has no Security Center). productState's middle byte is 0x10 or 0x11 while it scans.
function Get-IntenticSecurityProduct {
    try {
        $listed = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop)
    } catch {
        return ''
    }
    $on = @($listed | Where-Object { (([int]$_.productState -shr 8) -band 0xFF) -in 0x10, 0x11 })
    $named = @($on | Where-Object { "$($_.displayName)" -notmatch '^(Windows|Microsoft) Defender' }) + $on
    if ($named.Count -gt 0) { return "$($named[0].displayName)".Trim() }
    return ''
}

# Whether a failure is Windows' "Access is denied", at any depth: a cmdlet's own UnauthorizedAccessException, an
# IOException carrying E_ACCESSDENIED (0x80070005), or a process start's Win32 error 5 inside the
# ApplicationFailedException PowerShell wraps it in.
function Test-IntenticAccessDenied {
    param($Failure)
    while ($null -ne $Failure) {
        if ($Failure -is [System.UnauthorizedAccessException]) { return $true }
        if ($Failure -is [System.ComponentModel.Win32Exception] -and $Failure.NativeErrorCode -eq 5) { return $true }
        try { if ($Failure.HResult -eq -2147024891) { return $true } } catch { $null = $_ }
        $Failure = $Failure.InnerException
    }
    return $false
}

# Whether Windows refuses to open the file at $Path for reading. A failed start cannot always say so itself: PowerShell 7
# with its output captured retries a refused start another way and reports that retry's InvalidOperationException
# ("StandardErrorEncoding is only supported when standard error is redirected") instead of the refusal (2026-11-20).
function Test-IntenticFileDenied {
    param([string]$Path)
    if (-not $Path) { return $false }
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $stream.Dispose()
    } catch {
        return (Test-IntenticAccessDenied $_.Exception)
    }
    return $false
}

# The two halves of a stop for a file Windows refused: Suspect, a sentence for the problem line naming the product
# where Security Center names one, and Fix, who to ask to allow which folder. A path that is not a full one (or none)
# names the folder every Intentic program lives under.
function Get-IntenticSecurityAdvice {
    param([string]$Path)
    $product = Get-IntenticSecurityProduct
    $leaf = 'a file Intentic needs'
    $folder = Join-Path $HOME '.intentic'
    try {
        if ($Path -and [IO.Path]::IsPathRooted($Path)) {
            $leaf = Split-Path $Path -Leaf
            $folder = Split-Path $Path
        }
    } catch {
        $leaf = 'a file Intentic needs'
    }
    $who = if ($product) { "Security software on this PC ($product)" } else { 'Security software on this PC' }
    $manager = if ($product) { $product } else { 'the security software' }
    return @{
        Suspect = "$who may be blocking $leaf."
        Fix = "ask whoever manages $manager on this PC (at work, your IT) to allow the folder $folder, then run the same command again."
    }
}

# A failure's message as one line: a failed program start runs the position of the failing statement onto the end of
# its message ("...Access is deniedAt line:830 char:13"), over several lines, and a stop block's problem is a single
# line the desktop app reads. Takes the error record, whose position is what gets cut.
function Get-IntenticFailureLine {
    param($Record)
    $message = "$($Record.Exception.Message)"
    try {
        $position = @("$($Record.InvocationInfo.PositionMessage)" -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -First 1
        if ($position) { $message = $message.Replace("$position".Trim(), '') }
    } catch {
        $message = "$($Record.Exception.Message)"
    }
    $first = @($message -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -First 1
    return "$first".Trim()
}

# What the failing statement acted on: the file a cmdlet named, or the program a call tried to start. '' when the
# error record says neither.
function Get-IntenticFailureTarget {
    param($Record)
    try {
        $command = $Record.InvocationInfo.MyCommand
        if ($command -is [System.Management.Automation.ApplicationInfo]) { return "$($command.Path)" }
        if ($Record.CategoryInfo.TargetName) { return "$($Record.CategoryInfo.TargetName)" }
        if ($Record.TargetObject -is [string] -or $Record.TargetObject -is [IO.FileSystemInfo]) { return "$($Record.TargetObject)" }
        # A program PowerShell 7 could not start is named only inside its message, in quotes, with its full path.
        if ("$($Record.Exception.Message)" -match "'([A-Za-z]:\\[^']+)'") { return $Matches[1] }
    } catch {
        return ''
    }
    return ''
}

# Where an unexpected failure happened, as a parenthesis for the problem line: the step that was running, the command
# and what it acted on, and the line of the script. A bare "Access is denied" from a device with no step and no path
# (2026-11-20, intentic#49) could not be traced to anything; this is what it lacked.
function Get-IntenticFailurePlace {
    param($Record, [string]$Step)
    $said = @()
    if ($Step) { $said += "in step ""$Step""" }
    $command = ''
    $line = 0
    try {
        if ($Record.InvocationInfo.MyCommand) { $command = "$($Record.InvocationInfo.MyCommand.Name)" }
        $line = [int]$Record.InvocationInfo.ScriptLineNumber
    } catch {
        $line = 0
    }
    $target = Get-IntenticFailureTarget $Record
    if ($target -and $command -and $target.EndsWith($command)) { $command = '' }
    $what = (@($command, $target) | Where-Object { $_ }) -join ' '
    if ($what) { $said += "at $what" }
    if ($line -gt 0) { $said += "script line $line" }
    if ($said.Count -eq 0) { return '' }
    return '(' + ($said -join ', ') + ')'
}

function Invoke-IntenticScript {
    param([scriptblock]$Body)
    $IntenticKit.Code = 0
    try {
        & $Body
        Complete-IntenticStep 'ok'
    } catch {
        if ("$($_.Exception.Message)" -ne 'intentic:stop') {
            # Anything this script did not expect still ends in the protocol's stop block, never PowerShell's red one,
            # and says where it broke: the step, the command and its file, the line. A refusal by security software
            # names what to allow instead of asking for the same run again, which would only stop the same way.
            $failure = $_
            $said = (Get-IntenticFailureLine $failure).TrimEnd('.')
            $place = Get-IntenticFailurePlace $failure $IntenticKit.Step
            if ($place) { $said = "$said $place" }
            $said = "$said."
            $fix = 'run the same command again; if it stops here again, report it with this message.'
            $target = Get-IntenticFailureTarget $failure
            if ((Test-IntenticAccessDenied $failure.Exception) -or (Test-IntenticFileDenied $target)) {
                $advice = Get-IntenticSecurityAdvice -Path $target
                $said = "$said $($advice.Suspect)"
                $fix = $advice.Fix
            }
            try {
                Stop-Intentic 'The script stopped unexpectedly.' $said $fix
            } catch {
                $IntenticKit.Code = 1
            }
        }
    }
    $global:LASTEXITCODE = $IntenticKit.Code
    if ($PSCommandPath) { exit $IntenticKit.Code }
}
# <<< end of generated kit.ps1

# >>> generated from _site/site/scripts-kit/gzip.ps1: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# The .gz copy a release publishes beside each binary, unpacked: under half the bytes cross the network (42 of the agent's
# 93 MB), and .NET's GZipStream, which Windows PowerShell 5.1 has too, is all it takes. The binary is checked against
# the release's SHA256SUMS line for the binary itself, so the copy changes how many bytes arrive and nothing about
# which bytes are trusted.
function Expand-IntenticGzip {
    param([string]$Source, [string]$Destination)
    $in = $null
    $gzip = $null
    $out = $null
    try {
        $in = [System.IO.File]::OpenRead($Source)
        $gzip = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
        $out = [System.IO.File]::Create($Destination)
        $gzip.CopyTo($out)
    } finally {
        if ($null -ne $out) { $out.Close() }
        if ($null -ne $gzip) { $gzip.Close() }
        if ($null -ne $in) { $in.Close() }
    }
}

# Whether a failed request was a 404: what a release from before the copies answers for one, and the signal to fetch
# the binary itself instead. A .NET method's failure arrives wrapped, so the WebException is looked for.
function Test-IntenticMissing($Failure) {
    while ($null -ne $Failure -and -not ($Failure -is [System.Net.WebException])) { $Failure = $Failure.InnerException }
    return ($null -ne $Failure -and $null -ne $Failure.Response -and [int]$Failure.Response.StatusCode -eq 404)
}
# <<< end of generated gzip.ps1

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
# release asked for. A download is checked against the release's SHA256SUMS before anything runs it; a mismatch is
# deleted unrun and the ic already installed stays.

# Swap aside, never delete first (2026-11-20, intentic#49): Move-Item -Force onto an installed ic deletes it before the
# new one is in, and when Windows then refused the new one (security software holding the folder), a device that had a
# working ic was left with none. So the installed ic is renamed to ic.old.exe (Windows allows renaming a running
# program), the new one takes its name, and a failure puts the old one back before it rethrows. Where Windows refuses
# the name itself, putting it back fails too, so the old one stays as ic.old.exe and Get-IntenticIc runs it from there.
# Leftovers are removed only once ic.exe is a working ic: before that, one of them may be the only ic this device has.
function Get-IntenticIcLeftovers([string]$Dest) {
    $Leaf = [IO.Path]::GetFileNameWithoutExtension($Dest)
    return @(Get-ChildItem -LiteralPath (Split-Path $Dest) -Filter "$Leaf.old*.exe" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
}

function Install-IntenticIcFile([string]$From, [string]$Dest) {
    if (Test-IntenticIc $Dest) {
        foreach ($Left in (Get-IntenticIcLeftovers $Dest)) { Remove-Item -Force -LiteralPath $Left -ErrorAction SilentlyContinue }
    }
    $Old = [IO.Path]::ChangeExtension($Dest, '.old.exe')
    # Still there: an ic started from it is running, or it is the only working copy. A name of its own keeps it.
    if (Test-Path -LiteralPath $Old) { $Old = [IO.Path]::ChangeExtension($Dest, '.old-' + [guid]::NewGuid().ToString('N') + '.exe') }
    $Aside = $false
    if (Test-Path -LiteralPath $Dest) {
        Move-Item -LiteralPath $Dest -Destination $Old -ErrorAction Stop
        $Aside = $true
    }
    try {
        Move-Item -LiteralPath $From -Destination $Dest -ErrorAction Stop
    } catch {
        $Refusal = $_
        if ($Aside -and -not (Test-Path -LiteralPath $Dest)) {
            try { Move-Item -LiteralPath $Old -Destination $Dest -ErrorAction Stop } catch { $null = $_ }
        }
        throw $Refusal
    }
    foreach ($Left in (Get-IntenticIcLeftovers $Dest)) { Remove-Item -Force -LiteralPath $Left -ErrorAction SilentlyContinue }
}

# Test-IntenticIcNetwork: the failure is the network's (a name that does not resolve, a refused or reset connection, a
# timeout, an HTTP error) rather than this device's, at any depth. Matched by type name: System.Net.Http is not loaded
# in every Windows PowerShell 5.1 session, and naming one of its types there is itself an error.
function Test-IntenticIcNetwork($Failure) {
    while ($null -ne $Failure) {
        if ($Failure.GetType().FullName -match '^System\.Net\.|HttpResponseException$|TaskCanceledException$|TimeoutException$|AuthenticationException$') { return $true }
        $Failure = $Failure.InnerException
    }
    return $false
}

# Test-IntenticIc: the file starts and answers --version as ic does ('ic <version>'). A download that answered 200 can be
# a captive portal's login page or an empty body; Windows refuses to start either, which lands in the catch.
function Test-IntenticIc([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $said = ''
    try { $said = (& $Path --version | Out-String).Trim() } catch { $said = '' }
    return ($said -like 'ic *')
}

# Get-IntenticChecksumRefusal: why the file at $Path is not the asset $Asset the release at $Base published, by the
# SHA256SUMS beside it (@{ Why; Fix }), or $null when it is. A release from before its SHA256SUMS covered ic lists no
# ic-* asset at all, and has nothing to check against. IC_SKIP_CHECKSUM=1 installs ic unchecked from a server that
# publishes no SHA256SUMS; it never lets a mismatch through. The release also signs SHA256SUMS (minisign); that
# signature is the machine agent's to check, before it replaces ic or itself.
function Get-IntenticChecksumRefusal([string]$Path, [string]$Asset, [string]$Base) {
    $SumsHost = ([uri]$Base).Host
    $SumsFile = "$Path.SHA256SUMS"
    $Sums = @()
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile $SumsFile -ErrorAction Stop
        $Sums = @(Get-Content -LiteralPath $SumsFile -ErrorAction Stop)
    } catch {
        $Sums = @()
    }
    Remove-Item -Force $SumsFile -ErrorAction SilentlyContinue
    if ($Sums.Count -eq 0) {
        if ($env:IC_SKIP_CHECKSUM -eq '1') {
            Write-IntenticWarn "$SumsHost served no SHA256SUMS, so ic is installed unchecked (IC_SKIP_CHECKSUM=1)."
            return $null
        }
        return @{ Why = "$SumsHost served ic but not the SHA256SUMS to check it against."; Fix = 'run the same command again; IC_SKIP_CHECKSUM=1 installs ic unchecked from a server that publishes no SHA256SUMS.' }
    }
    $Want = ''
    $Listed = $false
    foreach ($Line in $Sums) {
        if ($Line -match '^([0-9a-fA-F]{64}) [ *](?:\./)?(\S+)\s*$') {
            if ($Matches[2] -eq $Asset) { $Want = $Matches[1].ToLowerInvariant() }
            if ($Matches[2] -like 'ic-*') { $Listed = $true }
        }
    }
    if (-not $Want) {
        if (-not $Listed) {
            Write-IntenticSay "this release's SHA256SUMS predates checksums for ic, so the download is not checked."
            return $null
        }
        return @{ Why = "the release's SHA256SUMS lists no $Asset, so the download cannot be checked."; Fix = 'run the same command again; if it says the same, report it: the release is missing a checksum.' }
    }
    # Get-FileHash is Windows PowerShell 4 and later; .NET's own SHA256 answers the same where it is missing.
    $Got = ''
    try {
        if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
            $Got = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path -ErrorAction Stop).Hash.ToLowerInvariant()
        } else {
            $Stream = [IO.File]::OpenRead($Path)
            try {
                $Got = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($Stream)) -replace '-', '').ToLowerInvariant()
            } finally {
                $Stream.Dispose()
            }
        }
    } catch {
        return @{ Why = "the download could not be read to check it ($($_.Exception.Message))."; Fix = 'run the same command again.' }
    }
    if ($Got -eq $Want) { return $null }
    return @{ Why = "the downloaded ic is not the one the release published (SHA-256 $Got, its SHA256SUMS says $Want), so it was deleted without being run."; Fix = "run the same command again; if it fails the same way, something between this device and $SumsHost is altering the download." }
}

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
    $IcHave = ''
    if ($env:IC_VERSION -and (Test-Path $IcDest)) {
        try { $IcHave = (& $IcDest --version | Out-String).Trim() } catch { $IcHave = '' }
    }
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
                    Install-IntenticIcFile "$IcDest.tmp" $IcDest
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
            # Why ic is not installed, by what failed (2026-11-20, intentic#49): $IcWhy once said "<host> did not answer"
            # whatever threw, and a device whose security software refused ic.exe was told to check a network that was
            # fine. 'network' keeps that wording with the failure's own words; 'refused' is a download that arrived and
            # was not installed (a checksum, a probe, a file Windows would not start); 'write' is a file Windows would not write.
            $IcFailed = 'network'
            $IcHost = ([uri]$IcBase).Host
            $IcWhy = "$IcHost did not answer from this device."
            $IcFix = 'check the network, then run the same command again.'
            # Named .exe so it can be started for the probe below; only a checked, probed download replaces the installed ic.
            $IcNew = "$IcDir\ic.download.exe"
            # The file being written when something throws: the download first, the installed ic once the swap starts.
            $IcWriting = $IcNew
            try {
                # By the .gz copy the release publishes beside ic (scripts-kit/gzip.ps1), else by ic itself: a release from
                # before the copies answers 404 for it, and so does a server that serves only ic (IC_URL).
                $IcPacked = $false
                try {
                    Invoke-WebRequest -UseBasicParsing -Uri "$IcBase/ic-windows-amd64.exe.gz" -OutFile "$IcNew.gz" -ErrorAction Stop
                    Expand-IntenticGzip -Source "$IcNew.gz" -Destination $IcNew
                    $IcPacked = $true
                } catch {
                    $IcPacked = $false
                } finally {
                    Remove-Item -Force "$IcNew.gz" -ErrorAction SilentlyContinue
                }
                if (-not $IcPacked) {
                    Invoke-WebRequest -UseBasicParsing -Uri "$IcBase/ic-windows-amd64.exe" -OutFile $IcNew -ErrorAction Stop
                }
                $IcRefusal = Get-IntenticChecksumRefusal $IcNew 'ic-windows-amd64.exe' $IcBase
                if ($IcRefusal) {
                    $IcFailed = 'refused'
                    $IcWhy = $IcRefusal.Why
                    $IcFix = $IcRefusal.Fix
                } elseif (Test-IntenticIc $IcNew) {
                    $IcWriting = $IcDest
                    Install-IntenticIcFile $IcNew $IcDest
                    $IcFetched = $true
                } elseif (-not (Test-Path -LiteralPath $IcNew)) {
                    # Gone between landing and its probe: taken into quarantine, which no network check would explain.
                    $IcAdvice = Get-IntenticSecurityAdvice -Path $IcNew
                    $IcFailed = 'refused'
                    $IcWhy = "the downloaded ic was removed from $IcNew as soon as it arrived. $($IcAdvice.Suspect)"
                    $IcFix = $IcAdvice.Fix
                } else {
                    $IcWhy = 'what downloaded is not a working program: a captive portal, a cut-off download, or the wrong architecture.'
                    # Test-IntenticIc reads every failure to start as "not ic"; one Windows refused is security software.
                    $IcStart = ''
                    try {
                        $null = & $IcNew --version
                    } catch {
                        if ((Test-IntenticAccessDenied $_.Exception) -or (Test-IntenticFileDenied $IcNew)) { $IcStart = Get-IntenticFailureLine $_ }
                    }
                    if (-not $IcStart -and (Test-IntenticFileDenied $IcNew)) { $IcStart = 'Access is denied' }
                    if ($IcStart) {
                        $IcAdvice = Get-IntenticSecurityAdvice -Path $IcNew
                        $IcFailed = 'refused'
                        $IcWhy = "Windows refused to start the downloaded ic at $IcNew ($IcStart). $($IcAdvice.Suspect)"
                        $IcFix = $IcAdvice.Fix
                    }
                }
            } catch {
                $IcFetched = $false
                $IcSaid = (Get-IntenticFailureLine $_).TrimEnd('.')
                if (Test-IntenticAccessDenied $_.Exception) {
                    $IcAdvice = Get-IntenticSecurityAdvice -Path $IcWriting
                    $IcFailed = 'write'
                    $IcWhy = "could not write $($IcWriting): $IcSaid. $($IcAdvice.Suspect)"
                    $IcFix = $IcAdvice.Fix
                } elseif ($IcWriting -eq $IcDest -or -not (Test-IntenticIcNetwork $_.Exception)) {
                    $IcFailed = 'write'
                    $IcWhy = "could not write $($IcWriting): $IcSaid."
                    $IcFix = "close anything running ic, check that $IcDir has room, then run the same command again."
                } else {
                    $IcWhy = "$IcHost did not answer from this device ($IcSaid)."
                }
            }
            Remove-Item -Force $IcNew -ErrorAction SilentlyContinue
            # The warning when an installed ic runs instead; <ic> is where it is.
            $IcKept = if ($IcFailed -ne 'network') { "the newest ic was not installed: $IcWhy The one installed at <ic> runs instead." } else { 'the newest ic could not be downloaded, so the one installed at <ic> runs instead.' }
            if ($IcFetched) {
                $Ic = $IcDest
                Add-IntenticPath -Folder $IcDir -Command 'ic'
            } elseif (Test-IntenticIc $IcDest) {
                Write-IntenticWarn $IcKept.Replace('<ic>', $IcDest)
                $Ic = $IcDest
            } elseif ($IcLeft = @(Get-IntenticIcLeftovers $IcDest | Where-Object { Test-IntenticIc $_ }) | Select-Object -First 1) {
                # The installed ic, moved aside by a swap Windows would not let finish (Install-IntenticIcFile).
                Write-IntenticWarn $IcKept.Replace('<ic>', $IcLeft)
                $Ic = $IcLeft
            } else {
                $IcInstalled = Get-Command ic -ErrorAction SilentlyContinue
                if ($IcInstalled -and (Test-IntenticIc $IcInstalled.Source)) {
                    Write-IntenticWarn $IcKept.Replace('<ic>', $IcInstalled.Source)
                    $Ic = $IcInstalled.Source
                } elseif ($IcFailed -eq 'refused') {
                    Stop-Intentic 'ic was downloaded but not installed, and no copy is installed.' $IcWhy $IcFix
                } elseif ($IcFailed -eq 'write') {
                    Stop-Intentic 'ic could not be installed, and no copy is installed.' $IcWhy $IcFix
                } else {
                    Stop-Intentic 'ic could not be downloaded, and no copy is installed.' $IcWhy $IcFix
                }
            }
        }
        Complete-IntenticStep
    }
    return $Ic
}
# <<< end of generated ic-fetch.ps1

Invoke-IntenticScript {
    # The names, read before anything is downloaded, so a mistyped one costs nothing. ic checks them again.
    $names = @($Slug | Where-Object { $_ })
    foreach ($name in $names) {
        if ($name -cnotmatch '^[a-z0-9-]+$') { Stop-Intentic 'Nothing was removed.' "$name is not the name of a sandbox." '' 2 }
    }
    $IcArgs = @('sandbox', 'remove') + $names
    if ($All) { $IcArgs += '--all' }
    if ($Yes) { $IcArgs += '--yes' }
    if ($Now) { $IcArgs += '--now' }
    if ($AgentAuth) { $IcArgs += '--agent-auth' }
    if ($Help) { $IcArgs = @('sandbox', 'remove', '--help') }

    $Ic = Get-IntenticIc
    Suspend-IntenticLine
    & $Ic @IcArgs
    Set-IntenticExit $LASTEXITCODE
}
