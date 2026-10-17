# intentic desktop sync: sync a local folder on THIS Windows device two ways with your sandbox's /work (block-delta,
# near real time), and mirror the sandbox's dev-server ports onto this device's localhost (both powered by Mutagen).
# Runs as YOU (no admin): it installs the one device agent into %USERPROFILE%\.intentic\machine and registers per-user
# logon entries so it resumes after a reboot. `intentic-machine sync uninstall` removes everything.
#
# THIS IS A BOOTSTRAP SHIM: its whole job is to put an agent that understands `sync setup` on a device that has none,
# then hand over to it, and that agent decides everything else (self-updating, putting the bin folder on your PATH,
# fetching the windowless launcher), so re-running this command still upgrades a device. The decisions live once, in
# the agent (_devices/machine/src/install.ts), where they are compiled and tested.
#
# Usage (the platform's Desktop sync card hands you this):
#   irm https://intentic.dev/sync/<SANDBOX_HOST>/<CODE> | iex
# where CODE is a single-use code the sandbox minted: this script spends it at https://<SANDBOX_HOST>/system/redeem/
# for the sandbox's address, its pairing token, and the folder and takeover the card set, none of which pass through
# $env:. The older shape (SANDBOX_URL and PAIR_TOKEN set in $env:) still works.
#
# Optional env:
#   SYNC_DIR            local folder to sync (default: %USERPROFILE%\intentic\<id>)
#   SYNC_REMOTE_DIR     the sandbox folder it syncs with: /work (the default), or /work/<name> for a project folder of
#                       your own, which also needs SYNC_PROJECT
#   SYNC_PROJECT        any non-empty value: SYNC_DIR is your own project, synced into SYNC_REMOTE_DIR with no sandbox
#                       state backup and no git bridge writing into it
#   SYNC_PROJECTS_HOST  any non-empty value: pair this device's own sandbox with no folder at all, so folders can attach
#                       to it later. Takes none of SYNC_DIR, SYNC_REMOTE_DIR and SYNC_PROJECT.
#   TAKEOVER            any non-empty value takes over sync from another device already connected to this sandbox
#   AGENT_BIN           local dev: run this command instead of the installed agent, whitespace-separated
#
# The script never ends the PowerShell it runs in: under irm | iex it returns with the code in $LASTEXITCODE.
param(
    [string]$Sandbox,
    [string]$Code
)

$ErrorActionPreference = 'Stop'

# WHICH HALF OF THE AGENT THIS SCRIPT CONNECTS, named once: `sync` here, `device` in device.ps1. The bootstrap block
# probes for it and the handover at the bottom makes it, so the two can never disagree.
$route = 'sync'

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

# >>> generated from _site/site/scripts-kit/redeem.ps1: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# Assert-IntenticCode <host> <code>: the command's own shape, checked before anything is downloaded, so a mangled one
# fails in a second. The code itself is spent later (below), after the steps that need none of what it stands for.
function Assert-IntenticCode {
    param([string]$Server, [string]$Code)
    if ($Server -notmatch '^[A-Za-z0-9.-]+$') { Stop-Intentic 'This command is not complete.' "$Server is not the address of a sandbox." 'get a new command from the card it came from.' }
    if ($Code -notmatch '^[A-Za-z0-9-]+$') { Stop-Intentic 'This code is not valid any more.' '' 'get a new command from the card it came from.' }
}

# Invoke-IntenticRedeem <host> <code> <kind> [name]: spend a single-use code at the sandbox that minted it. A spent code
# cannot be spent again, so a script redeems it AFTER the steps that need none of what it stands for (a download, a
# question, a token check): one of those failing leaves the code valid, and "run the same command again" stays true. The
# answer is `KEY=value` lines (_sandbox/sandbox/src/peers/redeem-codes.ts), returned as a hashtable of the keys a run
# started from the environment reads: SANDBOX_URL, PAIR_TOKEN, SYNC_DIR, TAKEOVER, CONNECT_TOKEN, ZONE, HOST_NAME,
# HOST_ID. Only those keys are taken, and they never pass through $env:, so no token outlives the run in the person's
# shell. -Name is the name a server will take if its code was minted without one, for the sandbox to answer that name's
# HOST_ID (the id its tunnel and container are named for); only a settled name (a-z, 0-9, _) is sent.
#
# Invoke-WebRequest -UseBasicParsing works on 5.1 and 7 alike. A 404 or 429 throws on both, with the body read back
# from the exception's response: 5.1 hands a WebResponse whose stream is still readable, 7 an HttpResponseMessage and
# the body in ErrorDetails.
function Invoke-IntenticRedeem {
    param([string]$Server, [string]$Code, [string]$Kind, [string]$Name)
    Assert-IntenticCode -Server $Server -Code $Code
    Write-IntenticStep '' "checking the code with $Server..." "Check the code for $Server"
    $query = ''
    if ($Name -cmatch '^[a-z0-9_]+$') { $query = "?name=$Name" }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $status = 0
    $body = ''
    try {
        $reply = Invoke-WebRequest -Method Post -UseBasicParsing -TimeoutSec 30 -Uri "https://$Server/system/redeem/$Code$query" -ErrorAction Stop
        $status = [int]$reply.StatusCode
        $body = if ($reply.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($reply.Content) } else { [string]$reply.Content }
    } catch {
        $response = $_.Exception.Response
        if ($null -ne $response) {
            try { $status = [int]$response.StatusCode } catch { $status = 0 }
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                $body = $_.ErrorDetails.Message
            } else {
                try {
                    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
                    $body = $reader.ReadToEnd()
                    $reader.Close()
                } catch { $body = '' }
            }
        }
    }
    if ($status -eq 404 -or $status -eq 429) {
        # The sandbox answers one sentence, "<what happened>: <what to do>". Anything else (a proxy's or a CDN's HTML
        # page, several lines, a wall of text) is not something to print as a headline.
        $said = "$body".Trim()
        if ($said -match '[<\r\n]' -or $said.Length -gt 200) { $said = '' }
        $at = $said.IndexOf(': ')
        if ($at -gt 0) { Stop-Intentic ($said.Substring(0, $at) + '.') '' $said.Substring($at + 2) }
        if ($said) { Stop-Intentic $said '' 'get a new command from the card it came from.' }
        if ($status -eq 429) { Stop-Intentic 'The code could not be checked.' "$Server has had too many tries from this device in the last minute." 'wait a minute, then run the same command again.' }
        Stop-Intentic 'This code is not valid any more.' '' 'get a new command from the card it came from.'
    }
    if ($status -eq 0) { Stop-Intentic 'The code could not be checked.' "$Server did not answer from this device." 'check the network, then run the same command again.' }
    if ($status -ne 200) { Stop-Intentic 'The code could not be checked.' "$Server answered with HTTP $status." 'run the same command again in a minute.' }
    $taken = @{}
    $kept = @('KIND', 'SANDBOX_URL', 'PAIR_TOKEN', 'SYNC_DIR', 'TAKEOVER', 'CONNECT_TOKEN', 'ZONE', 'HOST_NAME', 'HOST_ID')
    foreach ($line in ($body -split "`r?`n")) {
        $at = $line.IndexOf('=')
        if ($at -gt 0 -and $kept -contains $line.Substring(0, $at)) { $taken[$line.Substring(0, $at)] = $line.Substring($at + 1) }
    }
    if ($taken['KIND'] -ne $Kind) {
        $other = if ($taken['KIND']) { $taken['KIND'] } else { 'different thing' }
        Stop-Intentic 'This code belongs to another command.' "it connects a $other, and this command connects a $Kind." 'get a new command from the card it came from.'
    }
    Complete-IntenticStep
    return $taken
}
# <<< end of generated redeem.ps1

# >>> generated from _site/site/scripts-kit/agent-fetch.ps1: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# ---- bootstrap the agent binary (identical in device.ps1 and sync.ps1: generated from one source) ----
#
# Only when this device has no agent that can take the handover: one that can skips straight to `setup`,
# which asks the release channel itself and self-updates first. "Can" is asked by RUNNING the handover's own
# help, never by comparing versions - an agent that answers `version` can still be older than the words this
# script speaks to it, and then it is the `setup` that would have updated it that it cannot understand. That
# is what renaming the `computer` route to `device` did: every device paired before the rename answered the
# card's own command with "No command registered for `device`", with no route back to the self-update.
#
# The download is pinned to the tag `releases/latest` resolves to right now (one HEAD, no body, no API rate
# limit), so an interrupted transfer resumes against the exact release it started from, never a splice of
# two. What lands is probed by running it - `version` answering is the only proof the file is a working agent
# rather than 95 MB of captive-portal login page - and only a probed binary is moved into place.

function Get-IntenticAgentVersion {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return '' }
    try {
        # Run it to completion, THEN take its first line. `& $Path version | Select-Object -First 1` reads
        # better and is wrong: Select-Object stops the pipeline early, which leaves $LASTEXITCODE unset, so
        # every probe of a perfectly good agent failed its own exit-code check and reported no version.
        $out = & $Path version
        if ($LASTEXITCODE -ne 0) { return '' }
        $said = "$($out | Select-Object -First 1)".Trim()
        if ($said -match '^\d+\.\d+\.\d+$') { return $said }
        return ''
    } catch {
        # Not a binary, not this architecture, or too truncated to start: all of them are "no version", which
        # is the answer this exists to give. Nothing is silenced with a redirection - on 5.1 that would turn a
        # native command's stderr into a terminating NativeCommandError under $ErrorActionPreference = 'Stop'.
        return ''
    }
}

# WHETHER THE INSTALLED AGENT UNDERSTANDS THE HANDOVER, asked by running its help rather than by reading its
# version: `<route> setup --help` prints a usage screen and exits 0 on an agent that has the route, exits
# non-zero on one that does not, and connects nothing either way. Every one of -Flags has to be on that screen
# too: an agent older than one of them refuses the whole handover over it ("No flag registered"). The
# embedding script passes the flags its handover uses that are newer than the route, and none otherwise.
#
# Assigned to a variable rather than redirected, and the assignment is doing two jobs: it keeps the usage screen
# off the user's screen, and it keeps the function's return value a plain boolean instead of the help text
# plus a boolean. Silencing the older agent's complaint instead would need a stderr redirection, which no
# .ps1 here may hold while $ErrorActionPreference = 'Stop' is in force - on Windows PowerShell 5.1 that pair
# turns a native command's diagnostics into a terminating error, on the very outcome a probe exists to
# detect (src-tauri/src/scripts.rs holds that line for every bundled script). So the one line such an agent
# writes stays visible, which is no loss: it is the truth, and the line after it says what is being done.
function Test-IntenticAgentSpeaks {
    param([string]$Path, [string]$Route, [string[]]$Flags = @())
    try {
        $help = & $Path $Route setup --help
        if ($LASTEXITCODE -ne 0) { return $false }
        $said = "$help"
        foreach ($flag in $Flags) {
            if (-not $said.Contains($flag)) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

# What `releases/latest` currently points at, or '' when that cannot be established. A HEAD following the
# redirect: no body moves, and the answer is the tag itself.
function Get-IntenticPublishedVersion {
    try {
        $ask = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create('https://github.com/intentic/intentic/releases/latest')
        $ask.Method = 'HEAD'
        $ask.UserAgent = 'intentic-installer'
        $ask.Timeout = 20000
        $answer = $ask.GetResponse()
        $landed = $answer.ResponseUri.AbsoluteUri
        $answer.Close()
        if ($landed -match '/tag/v(\d+\.\d+\.\d+)$') { return $Matches[1] }
        return ''
    } catch {
        return ''
    }
}

# ONE FILE, RESUMED RATHER THAN RESTARTED, with a percentage while it moves.
#
# Invoke-WebRequest is not what does this. Windows PowerShell 5.1's holds the entire body in memory before it
# writes a byte, its progress repaint is itself a measurable share of the transfer, and `-Resume` does not
# exist before PowerShell 6. HttpWebRequest with a Range header is the one shape both hosts have, and it
# streams to disk a megabyte at a time.
#
# A range the other end ignores is the hazard worth naming: the answer is then the WHOLE file with a 200, and
# appending that to a partial produces a corrupt binary that no retry would ever fix. So the status is checked
# rather than assumed, and anything but 206 starts the file again from zero.
#
# Returns $true when the other end says the partial already holds every byte (416 to a resumed request: a run that
# finished the download and stopped before the swap), and $false after a transfer.
function Copy-IntenticFile {
    param([string]$Uri, [string]$Path)
    $have = 0
    if (Test-Path $Path) { $have = (Get-Item $Path).Length }
    $ask = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Uri)
    $ask.UserAgent = 'intentic-installer'
    $ask.Timeout = 30000
    $ask.ReadWriteTimeout = 120000
    if ($have -gt 0) { $ask.AddRange($have) }
    try {
        $answer = $ask.GetResponse()
    } catch {
        # A .NET method's failure arrives wrapped (MethodInvocationException), so the WebException is looked for.
        $failure = $_.Exception
        while ($null -ne $failure -and -not ($failure -is [System.Net.WebException])) { $failure = $failure.InnerException }
        $refused = $null
        if ($null -ne $failure) { $refused = $failure.Response }
        if ($have -gt 0 -and $null -ne $refused -and [int]$refused.StatusCode -eq 416) {
            $refused.Close()
            return $true
        }
        throw
    }
    if ($have -gt 0 -and $answer.StatusCode -ne [System.Net.HttpStatusCode]::PartialContent) {
        $answer.Close()
        Remove-Item -Force -ErrorAction SilentlyContinue $Path
        $have = 0
        $ask = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Uri)
        $ask.UserAgent = 'intentic-installer'
        $ask.Timeout = 30000
        $ask.ReadWriteTimeout = 120000
        $answer = $ask.GetResponse()
    }
    $total = $answer.ContentLength + $have
    # A repainting line where somebody is watching, one line per 10 percent where this is a pipe into the
    # desktop app's log - a carriage return in a log file is a line nobody can read.
    $live = -not [Console]::IsOutputRedirected
    $source = $null
    $file = $null
    $done = $have
    $shown = -1
    try {
        $source = $answer.GetResponseStream()
        $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $buffer = New-Object byte[] 1048576
        while ($true) {
            $read = $source.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) { break }
            $file.Write($buffer, 0, $read)
            $done += $read
            if ($total -gt 0) {
                # Every percent where a line can be repainted; every tenth where each one is a line of its own
                # in somebody's log. Both land on 100 exactly, because a progress readout that stops at 99 is
                # the one thing people read as "stuck".
                $percent = [int](100 * $done / $total)
                $mark = if ($live) { $percent } else { 10 * [int][math]::Floor($percent / 10) }
                if ($mark -gt $shown) {
                    $shown = $mark
                    $line = '  {0,3}% of {1} MB' -f $mark, [int]($total / 1MB)
                    if ($live) { Write-Host "`r$line" -NoNewline } else { Write-Host $line }
                }
            }
        }
    } finally {
        if ($null -ne $file) { $file.Close() }
        if ($null -ne $source) { $source.Close() }
        $answer.Close()
        if ($live -and $shown -ge 0) { Write-Host '' }
    }
    return $false
}

# By the .gz copy the release publishes beside the binary, resumed like the binary and unpacked once whole
# (scripts-kit/gzip.ps1): $true when $Part is the unpacked agent. $false sends the caller to the binary itself, which
# is what a release from before the copies has (its .gz answers 404), what a copy that does not unpack falls back to,
# and what a partial of the binary already here resumes.
function Get-IntenticPackedAgent {
    param([string]$Url, [string]$Part)
    if (Test-Path $Part) { return $false }
    $packed = "$Part.gz"
    Suspend-IntenticLine
    try {
        $null = Copy-IntenticFile -Uri "$Url.gz" -Path $packed
    } catch {
        Resume-IntenticLine
        if (Test-IntenticMissing $_.Exception) {
            Remove-Item -Force -ErrorAction SilentlyContinue $packed
            return $false
        }
        Stop-Intentic 'intentic-machine could not be downloaded.' "the download stopped before it finished ($($_.Exception.Message)); what arrived is kept, and running the same command again resumes it." 'check the network, then run the same command again.'
    }
    Resume-IntenticLine
    $unpacked = $true
    try {
        Expand-IntenticGzip -Source $packed -Destination $Part
    } catch {
        $unpacked = $false
        Remove-Item -Force -ErrorAction SilentlyContinue $Part
    } finally {
        Remove-Item -Force -ErrorAction SilentlyContinue $packed
    }
    return $unpacked
}

# Put a first agent at $Dest. Everything past this - keeping it current, PATH, the launcher stub - is the
# agent's own `setup`.
function Install-IntenticAgent {
    param([string]$Dest, [string]$Arch)
    $releases = 'https://github.com/intentic/intentic/releases'
    New-Item -ItemType Directory -Force -Path (Split-Path $Dest) | Out-Null
    # Windows PowerShell 5.1 negotiates whatever its .NET default is, and GitHub has required TLS 1.2 for
    # years: without this line the download fails on exactly the machines least able to explain why.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $published = Get-IntenticPublishedVersion
    # THE STAGED NAME ENDS IN .exe, AND THAT SUFFIX IS LOAD-BEARING. What lands is probed by running it, and
    # PowerShell resolves a command by EXTENSION: a path whose extension is not in PATHEXT is not a program to
    # it, whatever the bytes say. So `& $part version` on `intentic-machine.exe.part-1.248.0` fails with "not
    # recognized as the name of a cmdlet, function, script file, or operable program", the probe reads that as
    # "no version", and this function deletes a complete 83 MB download and blames a captive portal - which is
    # exactly what it did to the first machine that ever reached this path with an agent already installed.
    #
    # The agent's own `upgrade` stages without the suffix and is fine: it probes with spawn, and CreateProcess
    # loads a PE by its bytes. This block is the one that has to ask a shell.
    if ($published) {
        $url = "$releases/download/v$published/intentic-machine-windows-$Arch.exe"
        $part = "$Dest.part-$published.exe"
    } else {
        $url = "$releases/latest/download/intentic-machine-windows-$Arch.exe"
        $part = "$Dest.part.exe"
    }
    # A partial from another release is bytes that can never be finished.
    $leaf = Split-Path $Dest -Leaf
    Get-ChildItem -Path (Split-Path $Dest) -Filter "$leaf.part*" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -ne $part -and $_.FullName -ne "$part.gz" } |
        ForEach-Object { Remove-Item -Force -ErrorAction SilentlyContinue $_.FullName }
    $named = if ($published) { " $published" } else { '' }
    Write-IntenticStep '' "downloading intentic-machine$named..." "Download intentic-machine$named"
    $attempt = 0
    $packedAgent = Get-IntenticPackedAgent -Url $url -Part $part
    while (-not $packedAgent) {
        $attempt++
        # Copy-IntenticFile draws its own percentage, so the live line steps aside while it runs.
        Suspend-IntenticLine
        $fetched = $true
        $whole = $false
        $why = ''
        try {
            $whole = Copy-IntenticFile -Uri $url -Path $part
        } catch {
            $fetched = $false
            $why = $_.Exception.Message
        }
        Resume-IntenticLine
        if (-not $fetched) {
            Stop-Intentic 'intentic-machine could not be downloaded.' "the download stopped before it finished ($why); what arrived is kept, and running the same command again resumes it." 'check the network, then run the same command again.'
        }
        # A partial the other end calls finished is used when the probe below passes it. One that does not pass is
        # bytes no resume can mend (the 416 would come back on every run), so it is dropped and fetched again, once.
        if ($whole -and $attempt -eq 1 -and -not (Get-IntenticAgentVersion -Path $part)) {
            Remove-Item -Force -ErrorAction SilentlyContinue $part
            continue
        }
        break
    }
    if (-not (Get-IntenticAgentVersion -Path $part)) {
        Remove-Item -Force -ErrorAction SilentlyContinue $part
        Stop-Intentic 'intentic-machine could not be installed.' 'what downloaded is not a working program: a captive portal, a cut-off download, or the wrong architecture.' 'check the network, then run the same command again.'
    }
    # Swap, do not overwrite: Windows refuses to overwrite or delete a RUNNING executable - but it does allow
    # RENAMING one out of the way, which leaves the live process running from the renamed file while the new
    # binary takes its place. The leftover is cleared on the next run, once nothing is executing it.
    Remove-Item -Force -ErrorAction SilentlyContinue "$Dest.old"
    if (Test-Path $Dest) { Move-Item -Force -Path $Dest -Destination "$Dest.old" }
    Move-Item -Force -Path $part -Destination $Dest
    Complete-IntenticStep
}
# The agent to hand over to: AGENT_BIN as it is (a dev build, taken without asking), else the installed agent when it
# speaks the route and every flag in -Flags, else a fresh download. Returns the path, or '' for AGENT_BIN.
function Get-IntenticAgent {
    param([string]$Route, [string[]]$Flags = @())
    if ($env:AGENT_BIN) { return '' }
    # The only Windows agent a release publishes is x64, which Windows on ARM runs under emulation.
    $dest = Join-Path $HOME '.intentic\machine\bin\intentic-machine.exe'
    $have = Get-IntenticAgentVersion -Path $dest
    if ($have -and -not (Test-IntenticAgentSpeaks -Path $dest -Route $Route -Flags $Flags)) {
        Write-IntenticSay "intentic-machine $have on this device cannot take this handover, so a newer one replaces it."
        $have = ''
    }
    if (-not $have) { Install-IntenticAgent -Dest $dest -Arch 'amd64' }
    return $dest
}

# Run the agent with the handover's arguments and keep its exit code. AGENT_BIN is a whitespace-separated command: its
# first token is the program, the rest lead the arguments. Named, then splatted: `@(...)` is the array subexpression
# operator and would pass the whole list as one space-joined string. Only `@name` splats.
function Invoke-IntenticAgent {
    param([string]$Bin, [string[]]$Arguments)
    Suspend-IntenticLine
    if ($env:AGENT_BIN) {
        $parts = $env:AGENT_BIN -split '\s+'
        $lead = if ($parts.Length -gt 1) { $parts[1..($parts.Length - 1)] } else { @() }
        $agentArgs = @($lead) + $Arguments
        & $parts[0] @agentArgs
    } else {
        & $Bin @Arguments
    }
    Set-IntenticExit $LASTEXITCODE
}
# ---- end of the agent binary bootstrap ----
# <<< end of generated agent-fetch.ps1

Invoke-IntenticScript {
    $url = $env:SANDBOX_URL
    $pair = $env:PAIR_TOKEN
    $dir = $env:SYNC_DIR
    $takeover = $env:TAKEOVER
    $remoteDir = $env:SYNC_REMOTE_DIR
    $project = $env:SYNC_PROJECT
    $projectsHost = $env:SYNC_PROJECTS_HOST
    # A mangled command, or an env-var one missing a value, fails before the download. The code itself is spent after
    # it (below), so a download that breaks leaves it valid for the same command.
    $redeeming = [bool]($Sandbox -or $Code)
    if ($redeeming) {
        Assert-IntenticCode -Server $Sandbox -Code $Code
    } elseif ([string]::IsNullOrEmpty($url) -or [string]::IsNullOrEmpty($pair)) {
        Stop-Intentic 'Desktop sync could not be set up.' "the command is missing the sandbox's address or its pairing token." 'copy the command again from the Desktop sync card.'
    }
    # This device's own sandbox holds no folder: folders attach to it later, each as /work/<name>.
    if (-not [string]::IsNullOrEmpty($projectsHost) -and -not ([string]::IsNullOrEmpty($dir) -and [string]::IsNullOrEmpty($remoteDir) -and [string]::IsNullOrEmpty($project))) {
        Stop-Intentic 'Desktop sync could not be set up.' "SYNC_PROJECTS_HOST pairs this device's own sandbox, which holds no folder, and SYNC_DIR, SYNC_REMOTE_DIR or SYNC_PROJECT names one." 'unset SYNC_DIR, SYNC_REMOTE_DIR and SYNC_PROJECT, then run the same command again.' 2
    }

    # THE HANDOVER'S NEWER WORDS: the flags below that an agent older than them refuses outright, so an installed agent
    # whose `setup --help` does not list them is replaced like one without the route. Empty for an ordinary folder.
    $speaks = @()
    if (-not [string]::IsNullOrEmpty($remoteDir)) { $speaks += '--remote-dir' }
    if (-not [string]::IsNullOrEmpty($project)) { $speaks += '--project' }
    if (-not [string]::IsNullOrEmpty($projectsHost)) { $speaks += '--projects-host' }

    $bin = Get-IntenticAgent -Route $route -Flags $speaks
    # Still not spoken after the bootstrap: the newest release predates the handover's words, and the agent would refuse
    # them with a parser error that names a flag and nothing else. Said here instead, in words, before anything is
    # connected. A dev AGENT_BIN is taken as it is.
    if ($bin -and $speaks.Count -gt 0 -and -not (Test-IntenticAgentSpeaks -Path $bin -Route $route -Flags $speaks)) {
        $version = Get-IntenticAgentVersion -Path $bin
        if (-not [string]::IsNullOrEmpty($projectsHost)) {
            Stop-Intentic 'Desktop sync could not be set up.' "intentic-machine $version on this device cannot set up this device's own sandbox yet, so folders cannot attach to it." 'update the desktop app, or run this again once a newer agent is released.'
        }
        Stop-Intentic 'Desktop sync could not be set up.' "intentic-machine $version on this device does not understand $($speaks -join ' ') yet." 'update the desktop app, or run this again once a newer agent is released.'
    }

    if ($redeeming) {
        $granted = Invoke-IntenticRedeem -Server $Sandbox -Code $Code -Kind $route
        $url = $granted['SANDBOX_URL']
        $pair = $granted['PAIR_TOKEN']
        if ($granted['SYNC_DIR']) { $dir = $granted['SYNC_DIR'] }
        if ($granted['TAKEOVER']) { $takeover = $granted['TAKEOVER'] }
        if ([string]::IsNullOrEmpty($url) -or [string]::IsNullOrEmpty($pair)) {
            Stop-Intentic 'Desktop sync could not be set up.' "the sandbox's answer is missing its address or the pairing token." 'get a new command from the Desktop sync card.'
        }
    }

    $syncArgs = @($route, 'setup', '--url', $url, '--pair', $pair)
    if (-not [string]::IsNullOrEmpty($dir)) { $syncArgs += @('--dir', $dir) }
    if (-not [string]::IsNullOrEmpty($remoteDir)) { $syncArgs += @('--remote-dir', $remoteDir) }
    if (-not [string]::IsNullOrEmpty($project)) { $syncArgs += @('--project') }
    if (-not [string]::IsNullOrEmpty($projectsHost)) { $syncArgs += @('--projects-host') }
    if (-not [string]::IsNullOrEmpty($takeover)) { $syncArgs += @('--takeover') }
    Invoke-IntenticAgent -Bin $bin -Arguments $syncArgs
}
