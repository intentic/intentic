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
