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
function Write-Step($Phase, $Message) {
    Write-Host "intentic: [$Phase] $Message"
}

# Explicit params (direct file invocation) win; else the env vars the `irm | iex` one-liner carries. The env
# spelling is also what rides through to ic, so set it back for anything a param supplied.
if ($PlatformUrl) { $env:PLATFORM_URL = $PlatformUrl }
if ($ConnectToken) { $env:CONNECT_TOKEN = $ConnectToken }
if (-not $SetupCode) { $SetupCode = $env:SETUP_CODE }

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
