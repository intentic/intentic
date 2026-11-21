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
