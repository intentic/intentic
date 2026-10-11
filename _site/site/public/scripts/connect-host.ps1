<#
.SYNOPSIS
  intentic connect-host (Windows): connect THIS Windows device as a server (a deploy target) of an existing sandbox.

.DESCRIPTION
  The Windows counterpart of connect-host.sh. Windows cannot be a native SSH and Docker target, so, as connect.ps1's
  SELF_HOST path does, a Docker-in-Docker container (its own dockerd and sshd) becomes the server, and the sandbox
  deploys onto THAT over SSH. The sandbox here is REMOTE, so the server's sshd is exposed over its OWN Cloudflare tunnel
  (ssh-<id>.<zone>): a cloudflared container that SHARES the Docker-in-Docker container's network namespace, so the
  tunnel's ssh://localhost:22 origin resolves to its sshd. Then it registers with the sandbox's daemon (POST /enroll,
  authed by the connection token). It does NOT create or recreate a sandbox; that already exists from setup.

  The Infra screen hands out a single-use code (-Sandbox <host> -Code <code>): this script spends it at
  https://<host>/system/redeem/ for the sandbox's address, the connection token, the zone and the server's name, none
  of which pass through $env:. The Cloudflare token never rides the command: with no CF_TOKEN set, this script asks for
  it, once, without echoing it, and does not store it. A tunnel minted elsewhere can be handed in instead, as
  HOST_SSH_TUNNEL_TOKEN and HOST_SSH_HOSTNAME.

  Reboot survival is weaker than a Linux server (no systemd): the containers are --restart unless-stopped, so they come
  back only if Docker starts on login. Running the same command again restores them.

  The script never ends the PowerShell it runs in: under irm | iex it returns with the code in $LASTEXITCODE.

.EXAMPLE
  irm https://intentic.dev/server/<SANDBOX_HOST>/<CODE> | iex

.EXAMPLE
  $env:SANDBOX_URL='https://sandbox-<id>.<zone>'; $env:CONNECT_TOKEN='<token>'; $env:ZONE='<zone>'; irm https://intentic.dev/connect-host.ps1 | iex

.EXAMPLE
  $env:SANDBOX_URL='...'; $env:CONNECT_TOKEN='...'; $env:HOST_SSH_TUNNEL_TOKEN='...'; $env:HOST_SSH_HOSTNAME='ssh-<id>.<zone>'; $env:HOST_NAME='server1'; irm https://intentic.dev/connect-host.ps1 | iex
#>
param(
    [string]$SandboxUrl,
    [string]$ConnectToken,
    [string]$HostName,
    [string]$Sandbox,
    [string]$Code
)
# The docker probes below are expected to exit non-zero; this script branches on $LASTEXITCODE itself. NOT 'Stop':
# Windows PowerShell 5.1 turns a redirected native stderr into a terminating error, and every quiet probe here would
# end the run on the outcome it exists to detect (see connect.ps1).
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# The images: the Docker-in-Docker "host" (its own dockerd and sshd) is the actual server; the sandbox image carries the
# CLI that mints the own-Cloudflare host tunnel. Both track the latest release like connect.ps1.
$DindImage = if ($env:DIND_IMAGE) { $env:DIND_IMAGE } else { 'ghcr.io/intentic/dind-host:latest' }
$SandboxImage = if ($env:SANDBOX_IMAGE) { $env:SANDBOX_IMAGE } else { 'ghcr.io/intentic/sandbox:stable' }
$CloudflaredImage = if ($env:CLOUDFLARED_IMAGE) { $env:CLOUDFLARED_IMAGE } else { 'cloudflare/cloudflared:2026.10.0@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07' }

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

# >>> generated from _site/site/scripts-kit/redeem.ps1: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# Invoke-IntenticRedeem <host> <code> <kind>: spend a single-use code at the sandbox that minted it, before anything is
# downloaded, so a dead code fails in a second. The answer is `KEY=value` lines
# (_sandbox/sandbox/src/peers/redeem-codes.ts), returned as a hashtable of the keys a run started from the environment
# reads: SANDBOX_URL, PAIR_TOKEN, SYNC_DIR, TAKEOVER, CONNECT_TOKEN, ZONE, HOST_NAME. Only those keys are taken, and
# they never pass through $env:, so no token outlives the run in the person's shell.
#
# Invoke-WebRequest -UseBasicParsing works on 5.1 and 7 alike. A 404 or 429 throws on both, with the body read back
# from the exception's response: 5.1 hands a WebResponse whose stream is still readable, 7 an HttpResponseMessage and
# the body in ErrorDetails.
function Invoke-IntenticRedeem {
    param([string]$Server, [string]$Code, [string]$Kind)
    if ($Server -notmatch '^[A-Za-z0-9.-]+$') { Stop-Intentic 'This command is not complete.' "$Server is not the address of a sandbox." 'get a new command from the card it came from.' }
    if ($Code -notmatch '^[A-Za-z0-9-]+$') { Stop-Intentic 'This code is not valid any more.' '' 'get a new command from the card it came from.' }
    Write-IntenticStep '' "checking the code with $Server..." "Check the code for $Server"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $status = 0
    $body = ''
    try {
        $reply = Invoke-WebRequest -Method Post -UseBasicParsing -TimeoutSec 30 -Uri "https://$Server/system/redeem/$Code" -ErrorAction Stop
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
        # One sentence from the sandbox, "<what happened>: <what to do>".
        $said = "$((($body -split "`n") | Select-Object -First 1))".Trim()
        $at = $said.IndexOf(': ')
        if ($at -gt 0) { Stop-Intentic ($said.Substring(0, $at) + '.') '' $said.Substring($at + 2) }
        if (-not $said) { $said = 'This code is not valid any more.' }
        Stop-Intentic $said '' 'get a new command from the card it came from.'
    }
    if ($status -eq 0) { Stop-Intentic 'The code could not be checked.' "$Server did not answer from this device." 'check the network, then run the same command again.' }
    if ($status -ne 200) { Stop-Intentic 'The code could not be checked.' "$Server answered with HTTP $status." 'run the same command again in a minute.' }
    $taken = @{}
    $kept = @('KIND', 'SANDBOX_URL', 'PAIR_TOKEN', 'SYNC_DIR', 'TAKEOVER', 'CONNECT_TOKEN', 'ZONE', 'HOST_NAME')
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

function Normalize-HostName([string]$Value) {
    $Name = $Value.Trim().ToLowerInvariant() -replace '[^a-z0-9_]', '_'
    if (-not $Name) { return '' }
    if ($Name -match '^[0-9]') { $Name = "_$Name" }
    if ($Name -eq 'self') { return 'host' }
    return $Name
}

# Which failure a pull hit, in docker's own words - the same rule ic's docker.rs applies. The needles are the
# registry's own error codes, matched narrowly: Windows' "Access is denied." is the DAEMON refusing this
# account, and reading it as the registry refusing the package would blame our packaging for a local fault.
function Get-PullRefusal([string]$Said) {
    $text = $Said.ToLowerInvariant()
    # Read first: the credential store fails before any registry answer, and only it says these words.
    if ($text -match 'error getting credentials|credential helper|credsstore') { return 'credentials' }
    # ': denied' is ghcr.io's refusal when the word ends the line ("error from registry: denied").
    if ($text -match 'unauthorized|authentication required|denied:|: denied|access denied|insufficient_scope|forbidden') { return 'refused' }
    if ($text -match 'manifest unknown|manifest for|repository does not exist|name unknown') { return 'missing' }
    return 'broken'
}

# Attempts a broken transfer gets: a pull that dies mid-transfer keeps the layers that finished, so each retry is
# cheaper than the one before.
$PullAttempts = 3

# Pull a published image. A stale ghcr.io login (Docker's credential store presenting a dead token) is cleared once, but
# only for a failure shaped like an auth refusal (a person's own login is not a network blip's to throw away), and a
# torn download is retried rather than reported as a packaging fault. Docker's own lines pass through verbatim.
function Invoke-ImagePull([string]$Image) {
    Write-IntenticStep 'pulling-image' "pulling $Image (the first run can take a minute)..." "Download $Image"
    Suspend-IntenticLine
    $clearedLogin = $false
    $attempt = 0
    while ($true) {
        $attempt++
        $said = ((docker pull $Image 2>&1 | ForEach-Object { Write-Host $_; $_ }) -join "`n")
        if ($LASTEXITCODE -eq 0) {
            Resume-IntenticLine
            Complete-IntenticStep
            return
        }
        $refusal = Get-PullRefusal $said
        if ($refusal -eq 'refused' -and -not $clearedLogin) {
            $clearedLogin = $true
            Write-IntenticSay 'The registry refused the download, so a stale ghcr.io login is cleared and it is tried again without one.'
            docker logout ghcr.io *> $null
            continue
        }
        if ($refusal -eq 'broken' -and $attempt -lt $PullAttempts) {
            $wait = if ($attempt -eq 1) { 3 } else { 10 }
            Write-IntenticSay "The download broke before it finished; trying again in ${wait}s (attempt $($attempt + 1) of $PullAttempts)."
            Start-Sleep -Seconds $wait
            continue
        }
        switch ($refusal) {
            'refused' { Stop-Intentic "$Image could not be downloaded." 'the registry refused an anonymous download: the package is not public, which is ours to fix, not a fault on this device.' 'report it at https://github.com/intentic/intentic/issues' }
            'missing' { Stop-Intentic "$Image could not be downloaded." 'the registry has no such image, which is ours to fix, not a fault on this device.' 'report it at https://github.com/intentic/intentic/issues' }
            'credentials' { Stop-Intentic "$Image could not be downloaded." 'docker could not read its own saved credentials, so the download never reached the registry.' 'docker logout ghcr.io' }
            default { Stop-Intentic "$Image could not be downloaded." "the transfer broke $PullAttempts times; the layers that finished are kept." 'run the same command again when the network is steadier.' }
        }
    }
}

Invoke-IntenticScript {
    # Explicit params (a run as a file) win; else the env vars the older one-liner carries.
    if (-not $SandboxUrl) { $SandboxUrl = $env:SANDBOX_URL }
    if (-not $ConnectToken) { $ConnectToken = $env:CONNECT_TOKEN }
    if (-not $HostName) { $HostName = $env:HOST_NAME }
    $Zone = $env:ZONE
    # The code is spent first, so a dead one fails in a second, before anything is downloaded.
    if ($Sandbox -or $Code) {
        $granted = Invoke-IntenticRedeem -Server $Sandbox -Code $Code -Kind 'server'
        $SandboxUrl = $granted['SANDBOX_URL']
        $ConnectToken = $granted['CONNECT_TOKEN']
        if ($granted['ZONE']) { $Zone = $granted['ZONE'] }
        if ($granted['HOST_NAME']) { $HostName = $granted['HOST_NAME'] }
    }
    # Pre-provisioned host tunnel: the platform minted the tunnel and DNS under its zone and the command carries the
    # connector token and hostname, so there is no Cloudflare token and no tunnel to create here.
    $HostSshTunnelToken = $env:HOST_SSH_TUNNEL_TOKEN
    $HostSshHostname = $env:HOST_SSH_HOSTNAME
    $ProvidedTunnel = [bool]$HostSshTunnelToken -and [bool]$HostSshHostname
    # The key is generated INSIDE the Docker-in-Docker container (root-owned), so the sandbox always logs in as root.
    $HostUser = 'root'

    if (-not $SandboxUrl -or -not $ConnectToken) {
        Stop-Intentic 'This device could not be connected as a server.' "the command is missing the sandbox's address or its connection token." 'copy the command again from the Infra screen.'
    }
    # The pre-provisioned path requires an explicit HOST_NAME: the minted tunnel id was salted with the name picked on
    # the Infra screen, so a device-name default here would silently desync from it.
    if ($HostName) { $HostName = Normalize-HostName $HostName }
    if (-not $HostName) {
        if ($ProvidedTunnel) {
            Stop-Intentic 'This device could not be connected as a server.' "the command is missing the server's name, which a pre-provisioned tunnel needs." 'copy the command again from the Infra screen.'
        }
        $HostName = Normalize-HostName "$env:COMPUTERNAME"
        if (-not $HostName) { $HostName = 'host' }
    }

    # THE CLOUDFLARE TOKEN, asked for and never carried: it creates this server's tunnel and DNS on your zone, and goes
    # to the sandbox with the registration, which is the only place it is kept.
    $CfToken = $env:CF_TOKEN
    if (-not $ProvidedTunnel -and -not $CfToken) {
        if ($env:INTENTIC_NO_PROMPT -eq '1' -or -not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
            Stop-Intentic 'This device could not be connected as a server.' 'it needs a Cloudflare API token, and nobody is at this terminal to type one.' 'set $env:CF_TOKEN, then run the same command again.'
        }
        Suspend-IntenticLine
        Write-IntenticSay 'A Cloudflare API token (Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit) creates this server''s SSH tunnel on your zone. It is not stored on this device.'
        $secure = Read-Host -AsSecureString '     Cloudflare API token'
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $CfToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        if (-not $CfToken) {
            Stop-Intentic 'This device could not be connected as a server.' 'no Cloudflare API token was given.' 'create one at https://dash.cloudflare.com/profile/api-tokens, then run the same command again.'
        }
    }

    $Ic = Get-IntenticIc

    # Docker, and everything Windows needs before Docker can exist: one call into ic, which examines this device
    # (virtualization, WSL2, the features behind it, a pending restart, Docker, its engine, free space), asks once, and
    # fixes what it can. A prepare that stops has already said why.
    Suspend-IntenticLine
    & $Ic docker prepare
    if ($LASTEXITCODE -ne 0) {
        Set-IntenticExit $LASTEXITCODE
        return
    }

    if (-not $ProvidedTunnel) {
        Write-IntenticStep 'preflight' 'checking the Cloudflare API token...' 'Check the Cloudflare API token'
        try {
            $cfVerify = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' -Headers @{ Authorization = "Bearer $CfToken" }
        } catch {
            $cfVerify = $null
        }
        if (-not $cfVerify -or -not $cfVerify.success -or $cfVerify.result.status -ne 'active') {
            Stop-Intentic 'This device could not be connected as a server.' 'Cloudflare does not accept the API token: it is invalid, inactive, or missing a scope (Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit).' 'check the token at https://dash.cloudflare.com/profile/api-tokens, then run the same command again.'
        }
        Complete-IntenticStep
    }

    # Per-(sandbox, server) identity, so one device can host several servers and running the same command again reuses
    # this one (same volume: deployed containers and state survive). The digest matches the tunnel-id scheme.
    $slugInput = '{0}:{1}' -f $ConnectToken, $HostName
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $Slug = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($slugInput))) -replace '-', '').Substring(0, 12).ToLower()
    $DindContainer = "intentic-dind-host-$Slug"
    $DindVolume = "intentic-dind-docker-$Slug"
    $TunnelContainer = "intentic-host-ssh-tunnel-$Slug"

    Invoke-ImagePull $DindImage
    if (-not $ProvidedTunnel) { Invoke-ImagePull $SandboxImage }

    Write-IntenticStep '' 'starting the Docker-in-Docker server...' 'Start the server container'
    docker rm -f $DindContainer *> $null
    docker run -d --privileged --restart unless-stopped --name $DindContainer `
        -e DOCKER_TLS_CERTDIR= `
        -v "${DindVolume}:/var/lib/docker" `
        --dns 1.1.1.1 --dns 1.0.0.1 `
        $DindImage | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-Intentic 'This device could not be connected as a server.' 'docker could not start the server container; its output above says why.' 'run the same command again.'
    }
    # Wait until docker exec works, then generate a fresh ed25519 key inside the server and authorize it as its only key
    # (root-owned, 600: sshd rejects loose modes). The private half is read out for the sandbox.
    for ($i = 0; $i -lt 60; $i++) { docker exec $DindContainer true *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 1 }
    docker exec $DindContainer sh -c 'ssh-keygen -t ed25519 -N "" -C intentic-host -f /root/.ssh/intentic_ed25519 >/dev/null && cat /root/.ssh/intentic_ed25519.pub > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys' *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-Intentic 'This device could not be connected as a server.' 'the server container did not take its SSH key.' 'run the same command again.'
    }
    $HostSshKey = (docker exec $DindContainer cat /root/.ssh/intentic_ed25519) -join "`n"
    Complete-IntenticStep

    if ($ProvidedTunnel) {
        Write-IntenticSay "The server's SSH tunnel was made for it already: $HostSshHostname."
        $HostAddress = $HostSshHostname
    } else {
        Write-IntenticStep 'creating-tunnel' "creating this server's SSH tunnel..." "Create the server's SSH tunnel"
        Suspend-IntenticLine
        $tunnelArgs = @('run', '--rm', '--entrypoint', 'intentic', '-e', "CLOUDFLARE_API_TOKEN=$CfToken", '-e', "CONNECT_TOKEN=$ConnectToken", '-e', "HOST_NAME=$HostName")
        if ($Zone) { $tunnelArgs += @('-e', "ZONE=$Zone") }
        $tunnelArgs += @($SandboxImage, 'tunnel', 'host')
        $hostSshOut = & docker $tunnelArgs
        Resume-IntenticLine
        $HostSshTunnelToken = ($hostSshOut | Where-Object { $_ -like 'HOST_SSH_TUNNEL_TOKEN=*' } | Select-Object -First 1) -replace '^HOST_SSH_TUNNEL_TOKEN=', ''
        $HostAddress = ($hostSshOut | Where-Object { $_ -like 'HOST_SSH_HOSTNAME=*' } | Select-Object -First 1) -replace '^HOST_SSH_HOSTNAME=', ''
        if (-not $HostSshTunnelToken -or -not $HostAddress) {
            Stop-Intentic 'This device could not be connected as a server.' "the server's SSH tunnel could not be created; the output above says why." 'run the same command again.'
        }
        Complete-IntenticStep
    }

    # The connector SHARES the server container's network namespace (--network container:), so the tunnel's
    # ssh://localhost:22 origin is its own sshd. Recreating the server container orphans this connector, so both are
    # recreated together on every run.
    Write-IntenticStep '' 'starting the SSH tunnel connector...' 'Start the SSH tunnel connector'
    docker rm -f $TunnelContainer *> $null
    docker run -d --restart unless-stopped --name $TunnelContainer --network "container:$DindContainer" `
        $CloudflaredImage tunnel --no-autoupdate run --token $HostSshTunnelToken | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-Intentic 'This device could not be connected as a server.' 'docker could not start the SSH tunnel connector; its output above says why.' 'run the same command again.'
    }
    Complete-IntenticStep

    # Register with the sandbox (as connect-host.sh's ic machine enroll does with POST /enroll).
    Write-IntenticStep '' 'registering with the sandbox...' 'Register with the sandbox'
    $body = @{
        name    = $HostName
        user    = $HostUser
        address = $HostAddress
        port    = 22
        via     = 'cloudflared'
        sshKey  = $HostSshKey
    }
    # cfToken rides along only on the own-Cloudflare path; the pre-provisioned one has no token to hand over.
    if ($CfToken) { $body.cfToken = $CfToken }
    $enrolled = $true
    $why = ''
    try {
        Invoke-RestMethod -Method Post -Uri "$SandboxUrl/enroll" `
            -Headers @{ 'x-intentic-connect' = $ConnectToken } `
            -ContentType 'application/json' `
            -Body ($body | ConvertTo-Json -Compress) | Out-Null
    } catch {
        $enrolled = $false
        $why = $_.Exception.Message
    }
    if (-not $enrolled) {
        Stop-Intentic 'This device could not be connected as a server.' "the sandbox at $SandboxUrl did not accept the registration ($why); it may be unreachable, or its DevOps capability may be off." 'run the same command again once the sandbox answers.'
    }

    Write-IntenticFinished "This device is connected as server $HostName." "ssh://$HostAddress"
    Write-IntenticLater 'see its logs', "docker logs -f $DindContainer", 'stop it, keeping what it deployed', "docker stop $DindContainer $TunnelContainer"
}
