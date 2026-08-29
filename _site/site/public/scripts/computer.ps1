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

$url = $env:SANDBOX_URL
$pair = $env:PAIR_TOKEN
if ([string]::IsNullOrEmpty($url) -or [string]::IsNullOrEmpty($pair)) {
    Write-Error 'SANDBOX_URL and PAIR_TOKEN are required (copy the command from the computer''s card in your sandbox).'
    exit 1
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
# AGENT_BIN (local dev) short-circuits the download; otherwise the published binary is fetched on EVERY run, so
# re-running the card's command upgrades an existing install rather than pinning the machine to the version it
# first connected with.
$bin = $env:AGENT_BIN
if (-not $bin) {
    $dest = Join-Path $HOME '.intentic\machine\bin\intentic-machine.exe'
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Write-Host 'Downloading the intentic machine agent...'
    try {
        # Download beside the target, then swap: the connection runs FROM $dest, and Windows refuses to overwrite
        # or delete a running executable - but it does allow RENAMING one out of the way, which leaves the live
        # process running from the renamed file while the new binary takes its place. The leftover is cleared on
        # the next run, once nothing is executing it. A half-download never becomes $dest either.
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/intentic/intentic/releases/latest/download/intentic-machine-windows-$arch.exe" -OutFile "$dest.tmp"
        Remove-Item -Force -ErrorAction SilentlyContinue "$dest.old"
        if (Test-Path $dest) { Move-Item -Force -Path $dest -Destination "$dest.old" }
        Move-Item -Force -Path "$dest.tmp" -Destination $dest
        $bin = $dest
        Add-IntenticPath -Folder (Split-Path $dest) -Command 'intentic-machine'
        Get-IntenticLauncher -BinDir (Split-Path $dest) -Arch $arch
    } catch {
        Remove-Item -Force -ErrorAction SilentlyContinue "$dest.tmp"
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
