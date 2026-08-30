# intentic - connect THIS Windows computer to your sandbox, so the agent can work on it: run PowerShell, read
# and write files inside the folders you allow, and see the screen. Runs as YOU (no admin): installs the one
# machine agent into %USERPROFILE%\.intentic\machine (shared with desktop sync, if you enable that too), puts
# that folder on your PATH, and registers a per-user logon entry so the computer reconnects after a reboot.
# `intentic-machine computer uninstall` removes it. Nothing is opened on your network - the connection is
# outbound only.
#
# What the agent may actually do here is decided on the sandbox's capability card, not by this script, and is
# enforced by the agent installed on this machine. Revoking it there cuts this machine off immediately.
#
# Usage (the computer's capability card hands you this):
#   $env:SANDBOX_URL='https://sandbox-<id>.<zone>'; $env:PAIR_TOKEN='<token>'; irm https://intentic.dev/computer.ps1 | iex
#
# Required env: SANDBOX_URL, PAIR_TOKEN (the one-time token from the card).
# Optional: AGENT_BIN - local dev / dogfooding an unreleased build: run this command instead of downloading a
#           release, whitespace-separated (e.g. "node C:\intentic\_computers\machine\dist\cli.js").
#           FORCE_DOWNLOAD - any non-empty value re-downloads the agent even when this machine is already on
#           the published build (the download is otherwise skipped, see below).
$ErrorActionPreference = 'Stop'

# THE FOLDER A DOWNLOADED BINARY LANDS IN, PUT ON THE USER'S PATH - so `intentic-machine status` and
# `intentic-machine computer uninstall`, which this header and the setup output both name, are real commands
# rather than a promise the installer that made them cannot keep. The .sh twin gets this free with a symlink into
# ~/.local/bin; Windows has no such folder, so the user's own PATH is the only place to say it. Every Windows
# installer here carries an identical copy - they are standalone irm|iex files and cannot share code, so a test
# in the desktop crate holds the copies to each other.
#
# HKCU\Environment is written DIRECTLY rather than through [Environment]::SetEnvironmentVariable, which stores
# the value back as REG_SZ: every %USERPROFILE%- or %PNPM_HOME%-style entry already in that PATH would stop
# expanding, and each tool behind one would vanish from the user's shell - a far worse bug than the one this
# fixes, and the first machine tried had two such entries. Reading with DoNotExpandEnvironmentNames keeps them
# as tokens, and the value goes back under the kind it already had.
#
# Best-effort: PATH is the convenience, connecting is the job. A machine that refuses the edit is told where
# the agent is and keeps everything else.
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
        # This window has its own copy as well, and it is the one the user is looking at when the setup output
        # tells them what to run next.
        if (($env:Path -split ';') -notcontains $Folder) { $env:Path = "$env:Path;$Folder" }
    } catch {
        Write-Warning "Could not put $Folder on your PATH ($($_.Exception.Message)). Run $Command from that folder, or add it to your PATH yourself."
    }
}

# THE WINDOWLESS LAUNCHER, downloaded next to the agent - and the difference between a machine that quietly
# reconnects at every boot and one that flashes a black console window on the desktop while doing it.
#
# Windows gives every CONSOLE-subsystem program a console when Explorer starts it, and the agent is one, so the
# logon entry naming it directly put a terminal on screen for 1-2 seconds at every single boot. intentic-launch
# is a ~200 KB GUI-subsystem program (the loader creates no console for it at all) that starts the agent with
# CREATE_NO_WINDOW and exits; the agent registers THAT at logon when it finds it beside itself. Nothing else
# works: a hidden PowerShell host and a Task Scheduler logon task were both measured showing a window.
#
# Best-effort, and it says what its absence costs: the connection is the job, the silence is the polish. Same
# download-then-swap as the agent above, for the same reason - the stub may be running at this very moment.
# Every Windows agent installer carries an identical copy of this function (a test in the desktop crate holds
# them together); they are standalone irm|iex files and cannot share code.
function Get-IntenticLauncher {
    param([string]$BinDir, [string]$Arch)
    $stub = Join-Path $BinDir 'intentic-launch.exe'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/intentic/intentic/releases/latest/download/intentic-launch-windows-$Arch.exe" -OutFile "$stub.tmp"
        Remove-Item -Force -ErrorAction SilentlyContinue "$stub.old"
        if (Test-Path $stub) { Move-Item -Force -Path $stub -Destination "$stub.old" }
        Move-Item -Force -Path "$stub.tmp" -Destination $stub
    } catch {
        Remove-Item -Force -ErrorAction SilentlyContinue "$stub.tmp"
        Write-Warning "Could not download the windowless launcher ($($_.Exception.Message)). Everything still works; a console window will flash on your desktop when this machine starts the agent at login."
    }
}

# ---- the agent binary (identical in computer.ps1 and sync.ps1: standalone irm|iex files, no shared code) ----
#
# AGENT_BIN (local dev) short-circuits all of this. Otherwise this machine gets the PUBLISHED agent, and the
# first question is whether it already has it. Re-running the card's command is how a machine is UPGRADED, so
# this used to fetch ~95 MB on EVERY run - through Windows PowerShell 5.1's Invoke-WebRequest, which buffers
# the whole body in memory before it writes a byte, so it was also the slowest possible way to do it. On a
# home connection that is minutes; on a flaky one it is minutes that end in nothing, because a dropped
# transfer threw away every byte it had.
#
# Two cheap questions answer it instead. What does the agent already here say it is (`version` - which is also
# the only proof that the file is a working binary of a known build rather than something that merely exists)?
# And what does GitHub publish right now (one HEAD that transfers no body: `releases/latest` redirects to
# `.../tag/vX.Y.Z`, and unlike the API that answer carries no per-IP rate limit for an office to share)? Same
# answer, nothing to download. Different answers - or no agent here at all - and it downloads exactly as
# before, so re-running the card's command still upgrades a machine. It just stops paying for an upgrade
# there is none of.
#
# What this must never become again is a short-circuit on the mere PRESENCE of an agent: that pinned every
# machine to the version it first paired with, and agent fixes stopped reaching anyone already enrolled.
# "Skip" here means "already the published build", never "something is installed".
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

# Whether a file IS the agent this run is installing: it runs, and it states the version it was meant to be.
# THE CHECK THAT SEPARATES AN AGENT from 95 MB of captive-portal login page, from a truncated body, and from a
# binary for another architecture - a bun-compiled agent carries its bundle at the END of the file, so a
# partial one cannot answer at all. With no expected version (GitHub unreachable for the HEAD below), any
# agent that can state one is accepted, which is the old behaviour exactly.
function Test-IntenticAgent {
    param([string]$Path, [string]$Expect)
    $said = Get-IntenticAgentVersion -Path $Path
    if (-not $said) { return $false }
    if ($Expect) { return $said -eq $Expect }
    return $true
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

# The whole decision, and the only part of this the rest of the script sees: the path to run, or '' when this
# machine could not be given an agent at all.
function Get-IntenticAgent {
    param([string]$Dest, [string]$Arch)
    $releases = 'https://github.com/intentic/intentic/releases'
    $installed = Get-IntenticAgentVersion -Path $Dest
    $published = Get-IntenticPublishedVersion
    if ($installed -and $installed -eq $published -and -not $env:FORCE_DOWNLOAD) {
        Write-Host "The intentic machine agent is already the published build ($installed) - nothing to download."
        return $Dest
    }
    # PINNED TO THE TAG, not to `latest`, and that is what makes resuming safe: a partial can only ever be
    # continued against the exact release it started from, never spliced together out of two. Without a
    # resolved version there is nothing to pin to, so that run falls back to `latest` and starts clean.
    if ($published) {
        $url = "$releases/download/v$published/intentic-machine-windows-$Arch.exe"
        $part = "$Dest.part-$published"
        $label = "agent $published"
    } else {
        $url = "$releases/latest/download/intentic-machine-windows-$Arch.exe"
        $part = "$Dest.part"
        $label = 'agent'
    }
    # A partial from another release is bytes that can never be finished - and they are ~95 MB of them.
    $leaf = Split-Path $Dest -Leaf
    Get-ChildItem -Path (Split-Path $Dest) -Filter "$leaf.part*" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -ne $part } |
        ForEach-Object { Remove-Item -Force -ErrorAction SilentlyContinue $_.FullName }

    # A partial that is in fact COMPLETE: an earlier run got every byte and was killed before it could swap the
    # file in. Nothing to request - and asking first is also what keeps a range starting past the end of a
    # finished file from answering 416 across the user's screen.
    $ok = Test-IntenticAgent -Path $part -Expect $published
    if ($ok) { Write-Host "An earlier run had already downloaded the whole $label - installing that." }
    $attempts = 0
    while (-not $ok -and $attempts -lt 2) {
        $attempts += 1
        $have = 0
        if (Test-Path $part) { $have = (Get-Item $part).Length }
        if ($have -gt 0) {
            Write-Host "Resuming the download of the intentic machine $label - $([int]($have / 1MB)) MB of it is already here..."
        } else {
            Write-Host "Downloading the intentic machine $label..."
        }
        $finished = $true
        try {
            Copy-IntenticFile -Uri $url -Path $part
        } catch {
            $finished = $false
            Write-Warning "The download stopped: $($_.Exception.Message)"
        }
        $ok = Test-IntenticAgent -Path $part -Expect $published
        if (-not $ok -and $finished) {
            # The transfer FINISHED and what landed is still not this release: those bytes are not progress,
            # they are wrong, and resuming onto them could only ever produce this again. One clean attempt
            # from the start, then the caller's fallback ladder.
            Remove-Item -Force -ErrorAction SilentlyContinue $part
            if ($attempts -lt 2) { Write-Host "note: what downloaded isn't a working agent - trying once more from the start." }
        } elseif (-not $ok) {
            # A transfer that did NOT finish: a dropped connection, a timeout, a 5xx. Whatever arrived stays
            # exactly where it is - it is progress, and the next run continues from it rather than starting
            # the 95 MB over.
            Write-Host 'note: the part that did arrive is kept - re-running this command picks the download up from there.'
            break
        }
    }
    if (-not $ok) { return '' }
    # Swap, do not overwrite: Windows refuses to overwrite or delete a RUNNING executable - but it does allow
    # RENAMING one out of the way, which leaves the live process running from the renamed file while the new
    # binary takes its place. The leftover is cleared on the next run, once nothing is executing it.
    Remove-Item -Force -ErrorAction SilentlyContinue "$Dest.old"
    if (Test-Path $Dest) { Move-Item -Force -Path $Dest -Destination "$Dest.old" }
    Move-Item -Force -Path $part -Destination $Dest
    return $Dest
}
# ---- end of the agent binary block ----

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
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    # Windows PowerShell 5.1 negotiates whatever its .NET default is, and GitHub has required TLS 1.2 for
    # years: without this line the download fails on exactly the machines least able to explain why.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $bin = Get-IntenticAgent -Dest $dest -Arch $arch
    if ($bin) {
        # Both are repaired on every run, including the runs that download nothing (now most of them): a
        # machine whose PATH entry or launcher stub went missing gets them back without a re-download.
        Add-IntenticPath -Folder (Split-Path $dest) -Command 'intentic-machine'
        Get-IntenticLauncher -BinDir (Split-Path $dest) -Arch $arch
    } else {
        $installed = (Get-Command intentic-machine -ErrorAction SilentlyContinue).Source
        if ($installed) { Write-Warning "Could not download the latest agent - continuing with the installed $installed."; $bin = $installed }
        elseif (Get-Command npx -ErrorAction SilentlyContinue) { $bin = 'npx' }
        else { Write-Error 'Could not download the agent and no npx fallback (install Node.js, or see the docs).'; exit 1 }
    }
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
} elseif ($bin -eq 'npx') { & npx -y '@intentic/machine@latest' @hostArgs } else { & $bin @hostArgs }
