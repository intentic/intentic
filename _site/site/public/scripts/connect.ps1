<#
.SYNOPSIS
  intentic connect (Windows) - bootstrap shim, and now genuinely only that: fetch the `ic` CLI, let it get
  this PC ready for Docker (`ic docker prepare` - virtualization, WSL2, Docker Desktop, its engine), then hand
  the flow over to `ic sandbox connect`, which does everything else - the setup-code claim, tunnels, the
  launch, the Docker-in-Docker deploy target (SELF_HOST), desktop sync. Both flows live in _sandbox/ic.

  The CLI is fetched BEFORE Docker is looked at, which is the one ordering worth knowing about here: the
  Windows prerequisite tree is far too large to live in a shell script, and putting it in ic is what lets the
  terminal, the desktop app and the browser setup page all report the same diagnosis.

  The setup code carries the sandbox's reachability grant on intentic's own tunnel hub; the sandbox enables
  with it from inside. CF_TOKEN is only for SELF_HOST, which publishes THIS PC's SSH for the deploy engine.

.EXAMPLE
  $env:SETUP_CODE='<code>'; irm https://intentic.dev/connect.ps1 | iex

.EXAMPLE
  $env:SELF_HOST='1'; $env:CF_TOKEN='<cf>'; $env:SETUP_CODE='<code>'; irm https://intentic.dev/connect.ps1 | iex

.EXAMPLE
  ./connect.ps1 -ConnectToken <token>   # headless/scripted: raw values, no setup code
#>
param(
    [string]$PlatformUrl,
    [string]$ConnectToken,
    [string]$SetupCode,
    # Start without prompting even if other sandboxes are already running (the old always-proceed behavior).
    [switch]$Yes
)
# NOT 'Stop': this shim branches on $LASTEXITCODE itself - a child exiting non-zero is an ANSWER to act on,
# not a failure to abort into. Windows PowerShell 5.1 (what `powershell.exe` still is, and what the desktop app
# spawns) additionally turns a redirected native stderr into a terminating error under 'Stop'.
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# A PHASE OF THE INSTALL, ANNOUNCED ONCE - prose for a terminal, and a name for anything watching.
#
# The desktop app spawns this script and turns its stdout into a progress bar, so it has to know WHICH phase
# started; recognising the sentence would mean every rewording silently moved somebody's bar. Same contract as
# connect.sh's step() and ic's util::step, and the same vocabulary - anything written WITHOUT a phase is
# detail under the step that is running, never a step of its own.
# Split the same way ic splits them (its ui.rs): a PIPE gets the marker, unchanged and forever, because
# something is parsing it - the desktop app spawns this with redirected stdio. A TERMINAL gets the sentence
# alone; there the bracketed id says the same thing twice in a shape that reads like an error code, and these
# lines sit directly above the checklist ic is about to draw, where they would otherwise look like a different
# program's output. IsOutputRedirected is the same question ic's IsTerminal asks, and 5.1 has it.
#
# This shim keeps NARRATING either way. Going quiet in a terminal would be silence across a Docker install
# that can run ten minutes, which is the one stretch of this script that most needs to say something.
function Write-Step($Phase, $Message) {
    if ([Console]::IsOutputRedirected) {
        Write-Host "intentic: [$Phase] $Message"
    } else {
        Write-Host "  - $Message"
    }
}

# Explicit params (direct file invocation) win; else the env vars the `irm | iex` one-liner carries. The env
# spelling is also what rides through to ic, so set it back for anything a param supplied.
if ($PlatformUrl) { $env:PLATFORM_URL = $PlatformUrl }
if ($ConnectToken) { $env:CONNECT_TOKEN = $ConnectToken }
if (-not $SetupCode) { $SetupCode = $env:SETUP_CODE }

# THE FOLDER THE ic CLI LANDS IN, PUT ON THE USER'S PATH - so `ic sandbox doctor <slug>`, `ic sandbox remove
# <slug>` and every other command ic prints when it finishes are real commands rather than a promise the
# installer that made them cannot keep. The .sh twin gets this free with a symlink into ~/.local/bin; Windows
# has no such folder, so the user's own PATH is the only place to say it. Every Windows installer here carries
# an identical copy - they are standalone irm|iex files and cannot share code, so a test in the desktop crate
# holds the copies to each other.
#
# HKCU\Environment is written DIRECTLY rather than through [Environment]::SetEnvironmentVariable, which stores
# the value back as REG_SZ: every %USERPROFILE%- or %PNPM_HOME%-style entry already in that PATH would stop
# expanding, and each tool behind one would vanish from the user's shell - a far worse bug than the one this
# fixes, and the first machine tried had two such entries. Reading with DoNotExpandEnvironmentNames keeps them
# as tokens, and the value goes back under the kind it already had.
#
# Best-effort: PATH is the convenience, the install is the job. A machine that refuses the edit is told where
# the binary is and keeps everything else.
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

# ---- fetch the ic CLI (the same block recreate.ps1 and connect-host.ps1 carry, apart from its one narration
#      line - these are standalone irm|iex files and cannot share code, so a test holds them to it instead) ----
# Downloaded on EVERY run, so re-running the one-liner upgrades an existing install; only a failed download
# falls back to what's installed. IC_BIN overrides for local dev. Download-then-rename: overwriting a running
# executable fails, and a half-downloaded binary must never be what runs.
$Ic = $env:IC_BIN
if (-not $Ic) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $IcDir = "$env:USERPROFILE\.intentic\ic\bin"
    New-Item -ItemType Directory -Force -Path $IcDir | Out-Null
    $IcDest = "$IcDir\ic.exe"
    $IcBase = if ($env:IC_URL) { $env:IC_URL } else { 'https://github.com/intentic/intentic/releases/latest/download' }
    Write-Step 'fetching-ic' 'fetching the ic CLI...'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$IcBase/ic-windows-amd64.exe" -OutFile "$IcDest.tmp"
        Move-Item -Force "$IcDest.tmp" $IcDest
        $Ic = $IcDest
        Add-IntenticPath -Folder $IcDir -Command 'ic'
    } catch {
        Remove-Item -Force "$IcDest.tmp" -ErrorAction SilentlyContinue
        if (Test-Path $IcDest) {
            Write-Host "note: could not download the latest ic CLI - continuing with the installed $IcDest."
            $Ic = $IcDest
        } else {
            $installed = Get-Command ic -ErrorAction SilentlyContinue
            if ($installed) {
                Write-Host "note: could not download the latest ic CLI - continuing with the installed $($installed.Source)."
                $Ic = $installed.Source
            } else {
                Write-Error 'could not download the ic CLI and none is installed - check your network and re-run.'
                exit 1
            }
        }
    }
}

# ---- Docker, and everything Windows needs before Docker can exist ----
#
# This used to be forty lines of this script: is `docker` on PATH, does `docker info` answer, and if not,
# winget. It saw two of the dozen states a Windows PC can be in, and every other one arrived as the same
# sentence - most often "docker is not installed and winget is unavailable", which is a dead end on a machine
# where the only thing missing was a different download.
#
# It is now `ic docker prepare`: one read-only examination of this PC (Windows version, virtualization,
# WSL2, the features behind it, a pending restart, Docker itself, its group, its engine, its container mode,
# free space), one question covering everything that has to change, and then the changes. It is in ic rather
# than here because the SAME reading feeds the desktop app's install screen and the platform's setup page -
# and because a decision written in Rust is one the Linux runner that cross-builds this can actually test.
#
# Consent still comes from the same place it always did: INSTALL_DOCKER=1 pre-approves (the desktop app sets
# it), and otherwise ic asks on the terminal. Nothing below this line is reached until Docker answers.
& $Ic docker prepare
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Everything else - claim, tunnels, launch, the dind deploy target, sync - is ic's. The env this shell
# carries (CF_TOKEN, SANDBOX_IMAGE, SELF_HOST, ...) rides along.
$IcArgs = @('sandbox', 'connect')
if ($SetupCode) { $IcArgs += $SetupCode }
if ($Yes) { $IcArgs += '-y' }
& $Ic @IcArgs
exit $LASTEXITCODE
