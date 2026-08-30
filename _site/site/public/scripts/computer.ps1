# intentic - connect THIS Windows computer to your sandbox, so the agent can work on it: run PowerShell, read
# and write files inside the folders you allow, and see the screen. Runs as YOU (no admin): installs the one
# machine agent into %USERPROFILE%\.intentic\machine and registers a per-user logon entry so the computer
# reconnects after a reboot. `intentic-machine computer uninstall` removes it. Nothing is opened on your
# network - the connection is outbound only.
#
# What the agent may actually do here is decided on the sandbox's capability card, not by this script, and is
# enforced by the agent installed on this machine. Revoking it there cuts this machine off immediately.
#
# THIS IS A BOOTSTRAP SHIM: its whole job is to put a FIRST agent on a machine that has none, then hand over
# to `intentic-machine computer setup`, which decides everything else - self-updating an installed agent,
# putting the bin folder on your PATH, fetching the windowless launcher - so re-running this command still
# upgrades a machine. The decisions used to live here, copied across four scripts in two shell dialects; they
# now live once, in the agent (_computers/machine/src/install.ts), where they are compiled and tested.
#
# Usage (the computer's capability card hands you this):
#   $env:SANDBOX_URL='https://sandbox-<id>.<zone>'; $env:PAIR_TOKEN='<token>'; irm https://intentic.dev/computer.ps1 | iex
#
# Required env: SANDBOX_URL, PAIR_TOKEN (the one-time token from the card).
# Optional: AGENT_BIN - local dev / dogfooding an unreleased build: run this command instead of the installed
#           agent, whitespace-separated (e.g. "node C:\intentic\_computers\machine\dist\cli.js").
$ErrorActionPreference = 'Stop'

# ---- bootstrap the agent binary (identical in computer.ps1 and sync.ps1: standalone irm|iex files, no shared code) ----
#
# Only when NO working agent is installed: a machine that has one skips straight to `setup`, which asks the
# release channel itself and self-updates first. The download is pinned to the tag `releases/latest` resolves
# to right now (one HEAD, no body, no API rate limit), so an interrupted transfer resumes against the exact
# release it started from, never a splice of two. What lands is probed by running it - `version` answering is
# the only proof the file is a working agent rather than 95 MB of captive-portal login page - and only a
# probed binary is moved into place.

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
function Copy-IntenticFile {
    param([string]$Uri, [string]$Path)
    $have = 0
    if (Test-Path $Path) { $have = (Get-Item $Path).Length }
    $ask = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Uri)
    $ask.UserAgent = 'intentic-installer'
    $ask.Timeout = 30000
    $ask.ReadWriteTimeout = 120000
    if ($have -gt 0) { $ask.AddRange($have) }
    $answer = $ask.GetResponse()
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
    if ($published) {
        $url = "$releases/download/v$published/intentic-machine-windows-$Arch.exe"
        $part = "$Dest.part-$published"
    } else {
        $url = "$releases/latest/download/intentic-machine-windows-$Arch.exe"
        $part = "$Dest.part"
    }
    # A partial from another release is bytes that can never be finished.
    $leaf = Split-Path $Dest -Leaf
    Get-ChildItem -Path (Split-Path $Dest) -Filter "$leaf.part*" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -ne $part } |
        ForEach-Object { Remove-Item -Force -ErrorAction SilentlyContinue $_.FullName }
    Write-Host "Downloading the intentic machine agent $published..."
    try {
        Copy-IntenticFile -Uri $url -Path $part
    } catch {
        Write-Error "the download didn't finish ($($_.Exception.Message)) - what did arrive is kept, so re-running this command resumes it."
        exit 1
    }
    if (-not (Get-IntenticAgentVersion -Path $part)) {
        Remove-Item -Force -ErrorAction SilentlyContinue $part
        Write-Error "what downloaded isn't a working agent (a captive portal, a truncated body, or the wrong architecture) - re-run this command to try again."
        exit 1
    }
    # Swap, do not overwrite: Windows refuses to overwrite or delete a RUNNING executable - but it does allow
    # RENAMING one out of the way, which leaves the live process running from the renamed file while the new
    # binary takes its place. The leftover is cleared on the next run, once nothing is executing it.
    Remove-Item -Force -ErrorAction SilentlyContinue "$Dest.old"
    if (Test-Path $Dest) { Move-Item -Force -Path $Dest -Destination "$Dest.old" }
    Move-Item -Force -Path $part -Destination $Dest
}
# ---- end of the agent binary bootstrap ----

$url = $env:SANDBOX_URL
$pair = $env:PAIR_TOKEN
if ([string]::IsNullOrEmpty($url) -or [string]::IsNullOrEmpty($pair)) {
    Write-Error 'SANDBOX_URL and PAIR_TOKEN are required (copy the command from the computer''s card in your sandbox).'
    exit 1
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$bin = $env:AGENT_BIN
if (-not $bin) {
    $dest = Join-Path $HOME '.intentic\machine\bin\intentic-machine.exe'
    if (-not (Get-IntenticAgentVersion -Path $dest)) { Install-IntenticAgent -Dest $dest -Arch $arch }
    $bin = $dest
}

$hostArgs = @('computer', 'setup', '--url', $url, '--pair', $pair)
if (-not [string]::IsNullOrEmpty($env:AGENT_BIN)) {
    # A whitespace-separated command: first token is the executable, the rest are leading args before setup.
    $parts = $env:AGENT_BIN -split '\s+'
    $lead = if ($parts.Length -gt 1) { $parts[1..($parts.Length - 1)] } else { @() }
    # Named, then splatted: `@(...)` is the array subexpression operator and would pass the whole argument
    # list as one space-joined string (connect.ps1 has the long version). Only `@name` splats.
    $agentArgs = $lead + $hostArgs
    & $parts[0] @agentArgs
} else { & $bin @hostArgs }
