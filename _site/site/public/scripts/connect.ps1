<#
.SYNOPSIS
  intentic connect (Windows) - bootstrap shim: get Docker Desktop onto this PC, fetch the `ic` CLI, and hand
  the flow over to `ic sandbox connect`, which does everything else - the setup-code claim, tunnels, the
  launch, the Docker-in-Docker deploy target (SELF_HOST), desktop sync. The flow lives in _sandbox/ic.

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
# NOT 'Stop': this shim probes with docker and branches on $LASTEXITCODE itself - a probe exiting non-zero is
# the ANSWER, not a failure. Windows PowerShell 5.1 (what `powershell.exe` still is, and what the desktop app
# spawns) additionally turns a redirected native stderr into a terminating error under 'Stop'.
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# Explicit params (direct file invocation) win; else the env vars the `irm | iex` one-liner carries. The env
# spelling is also what rides through to ic, so set it back for anything a param supplied.
if ($PlatformUrl) { $env:PLATFORM_URL = $PlatformUrl }
if ($ConnectToken) { $env:CONNECT_TOKEN = $ConnectToken }
if (-not $SetupCode) { $SetupCode = $env:SETUP_CODE }

Write-Host 'intentic: checking Docker...'
$DockerInstalled = $false
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    # Best-effort guided install: winget can install Docker Desktop, but a first WSL2 setup may require a
    # reboot - the daemon wait below names that remedy. Never silent: consent (naming Docker's terms) first.
    if ($env:INSTALL_DOCKER -ne '1') {
        $answer = Read-Host 'intentic: Docker Desktop is not installed. Install it now via winget? Continuing accepts Docker''s terms (https://www.docker.com/legal/docker-subscription-service-agreement) [Y/n]'
        if ($answer -match '^[nN]') {
            Write-Error 'docker is required - install Docker Desktop (https://docs.docker.com/get-docker/) and re-run.'
            exit 1
        }
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Error 'docker is not installed and winget is unavailable - install Docker Desktop (https://docs.docker.com/get-docker/), then re-run.'
        exit 1
    }
    Write-Host 'intentic: installing Docker Desktop (winget, ~500 MB)...'
    winget install --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'Docker Desktop install failed - install it manually (https://docs.docker.com/get-docker/), then re-run.'
        exit 1
    }
    # A fresh install isn't on this session's PATH yet; point at the standard install location and launch it.
    $env:Path += ";$env:ProgramFiles\Docker\Docker\resources\bin"
    $dockerDesktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerDesktop) { Start-Process $dockerDesktop }
    $DockerInstalled = $true
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    if (-not $DockerInstalled) {
        Write-Error 'the docker daemon is not running. Start Docker Desktop, then re-run.'
        exit 1
    }
    Write-Host 'intentic: waiting for Docker Desktop (accept the first-run dialog if shown)...'
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 5
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { break }
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'the Docker daemon did not come up - if Windows asked to reboot (WSL2 setup), reboot and re-run this command.'
        exit 1
    }
}

# ---- fetch the ic CLI (keep in lockstep with recreate.ps1 - standalone irm|iex files) ----
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
    Write-Host 'intentic: fetching the ic CLI...'
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

# Everything else - claim, tunnels, launch, the dind deploy target, sync - is ic's. The env this shell
# carries (CF_TOKEN, SANDBOX_IMAGE, SELF_HOST, ...) rides along.
$IcArgs = @('sandbox', 'connect')
if ($SetupCode) { $IcArgs += $SetupCode }
if ($Yes) { $IcArgs += '-y' }
& $Ic @IcArgs
exit $LASTEXITCODE
