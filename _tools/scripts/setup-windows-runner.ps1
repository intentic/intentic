<#
.SYNOPSIS
  Provision this PC as the Windows CI runner, and bring an existing one back to the shape the desktop tiers
  need. Companion to docs/ci-runner-windows.md, which explains why the shape is what it is.

  THE ONE THING THE PIPELINE CANNOT DO FOR ITSELF. Everything else the Windows tiers want of a machine, they
  reconcile on their own: every tier now tears down before it asserts, so a leftover install, a stray sandbox
  container or a half-finished previous run heals without anybody logging in. The exception is the runner's own
  SESSION. A job runs inside the runner process, so it cannot move that process onto a desktop it does not have
  — and a runner installed the ordinary way, as a Windows service, has no desktop at all. Session 0 maps no
  windows, and every assertion in tier 1 reads a window title. That is a property of how the runner was
  REGISTERED, which is this script, run once per machine.

  Idempotent, and a reconciler rather than an installer: run it on a machine somebody already registered as a
  service and it takes the service out and puts the logon task in.

  SAVED WITH A UTF-8 BOM, AND IT HAS TO STAY. Windows PowerShell 5.1 — still what an elevated "PowerShell"
  window is on a stock Windows 11, and so what somebody following the docs above will use — reads a BOM-less
  file as ANSI, which turns each em dash in the strings below into a byte it takes for a closing quote. That is
  not a display problem: it ends those strings early and the script dies as five parse errors having done
  nothing. pwsh reads UTF-8 with or without the mark, which is exactly how a file that had never run under 5.1
  passed every test it was given.

.EXAMPLE
  # From an ELEVATED PowerShell. Token from Settings > Actions > Runners > New self-hosted runner (Windows x64).
  ./setup-windows-runner.ps1 -Url https://github.com/intentic -Token <registration-token>

.EXAMPLE
  # Re-run against an already-registered machine to repair its session, no token needed.
  ./setup-windows-runner.ps1 -Repair
#>
param(
    # The scope the token came from — an organisation token pairs with https://github.com/<org>, a repository
    # token with https://github.com/<org>/<repo>. Crossing them fails as a 404 that reads like an expired token.
    [string]$Url,
    [string]$Token,
    [string]$Name = $env:COMPUTERNAME.ToLower(),
    # `runs-on` is an AND over labels, so this box must NOT carry the Linux fleet's `intentic` label — it would
    # be offered every container job in the pipeline and fail them all. See docs/ci-runner-windows.md.
    [string]$Labels = 'windows-desktop',
    [string]$RunnerRoot = 'C:\actions-runner',
    # Pinned only when you need a specific one; otherwise the latest release.
    [string]$RunnerVersion,
    # Survive an unattended reboot by logging the account in automatically. OFF by default and deliberately so:
    # it writes a password into the registry in cleartext, which is a poor trade on a machine anybody uses. Left
    # off, the runner comes back at the next sign-in.
    [switch]$AutoLogon,
    # Repair an existing registration's session without reconfiguring it. No -Url/-Token needed.
    [switch]$Repair
)
# Not 'Stop': this script probes with native commands and branches on what they answer. A probe exiting
# non-zero is the ANSWER here, not a failure.
$ErrorActionPreference = 'Continue'

$TaskName = 'GitHub Actions Runner'
$Account = "$env:USERDOMAIN\$env:USERNAME"

function Step($message) { Write-Host "intentic: $message" }
function Die($message) {
    Write-Host "intentic: $message" -ForegroundColor Red
    exit 1
}

# Removing a service and registering a task for a named principal are both administrator operations. Checked
# up front rather than failing halfway with the service gone and no task in its place.
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die 'run this from an elevated PowerShell (Run as administrator).'
}
if (-not $Repair -and (-not $Url -or -not $Token)) {
    Die 'need -Url and -Token to register a new runner, or -Repair to fix an existing one.'
}

# ── where the runner actually is ─────────────────────────────────────────────────────────────────────────────
# $RunnerRoot's default is THIS SCRIPT'S convention, and the machine -Repair exists for — one somebody
# registered the ordinary way, as a service — is exactly the machine that never followed it. The Windows runner
# was configured at C:\runner, so the bare `-Repair` that `doctor` prints on finding session 0 died on "no
# runner to repair" while the runner it meant ran beside it: the one failure a person has to fix by hand, and
# the instruction for fixing it did not work on the machine it was printed about.
#
# So an unpassed -RunnerRoot is DISCOVERED from what is already installed — the service's own image path first,
# since on the failing machine the service IS the thing being removed, then a listener already running, for a
# root someone registered as a task under a different convention. Both name <root>\bin\<exe>, hence two parents.
if (-not $PSBoundParameters.ContainsKey('RunnerRoot')) {
    $image = (Get-CimInstance Win32_Service -Filter "Name LIKE 'actions.runner.%'" -ErrorAction SilentlyContinue |
        Select-Object -First 1).PathName
    if (-not $image) {
        $image = (Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue |
            Select-Object -First 1).ExecutablePath
    }
    # A service's image path is quoted when the path has spaces in it, and can carry arguments after the exe.
    if ($image) { $image = $image.Trim() }
    if ($image -and $image.StartsWith('"')) { $image = $image.Substring(1).Split('"')[0] }
    if ($image) {
        $found = Split-Path (Split-Path $image -Parent) -Parent
        # Asserted rather than assumed: a directory with no run.cmd in it is not a runner root, and adopting one
        # silently would point the repair at nothing while reporting that it had found the installation.
        if ($found -and (Test-Path (Join-Path $found 'run.cmd'))) {
            $RunnerRoot = $found
            Step "found the runner at $RunnerRoot"
        }
    }
}

# ── the runner package ───────────────────────────────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $RunnerRoot 'run.cmd'))) {
    if ($Repair) {
        Die "no runner to repair: nothing at $RunnerRoot, and no service or listener on this machine pointed anywhere else. Pass -RunnerRoot if it is installed somewhere this could not see."
    }
    Step "downloading the runner into $RunnerRoot..."
    New-Item -ItemType Directory -Force -Path $RunnerRoot | Out-Null
    if (-not $RunnerVersion) {
        $latest = Invoke-RestMethod 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{ 'User-Agent' = 'intentic' }
        $RunnerVersion = $latest.tag_name.TrimStart('v')
    }
    $zip = Join-Path $RunnerRoot "actions-runner-win-x64-$RunnerVersion.zip"
    Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $RunnerRoot -Force
}

# ── reconcile: the service registration this script exists to replace ────────────────────────────────────────
# `svc.cmd` is only present when config.cmd created the service, and a machine can carry the service without it
# — so the service is addressed directly, which works either way.
$service = Get-Service -Name 'actions.runner.*' -ErrorAction SilentlyContinue
if ($service) {
    Step "removing the runner service ($($service.Name)) — it runs in session 0, which has no desktop..."
    & sc.exe stop $service.Name | Out-Null
    Start-Sleep -Seconds 8
    & sc.exe delete $service.Name | Out-Null
    Start-Sleep -Seconds 3
    # The work tree the service left behind belongs to its account (NETWORK SERVICE), and git refuses a
    # checkout into a tree it does not own as "dubious ownership". The runner recreates this on its next job.
    Step 'clearing the work tree the service account owned...'
    Remove-Item (Join-Path $RunnerRoot '_work') -Recurse -Force -ErrorAction SilentlyContinue
    & icacls $RunnerRoot /grant "$($env:USERNAME):(OI)(CI)F" /T /C 2>&1 | Out-Null
}

# ── register ─────────────────────────────────────────────────────────────────────────────────────────────────
if (-not $Repair) {
    Step "registering as '$Name' with labels '$Labels'..."
    Push-Location $RunnerRoot
    # NOT --runasservice. That switch is the whole bug this script exists to prevent.
    & cmd /c "config.cmd --url $Url --token $Token --name $Name --labels $Labels --work _work --unattended --replace"
    $configured = $LASTEXITCODE -eq 0
    Pop-Location
    if (-not $configured) { Die 'the runner refused to configure — check the URL scope and that the token is fresh.' }
}

# ── the session ──────────────────────────────────────────────────────────────────────────────────────────────
Step "registering a logon task that runs the listener in $Account's own desktop session..."
$action = New-ScheduledTaskAction -Execute (Join-Path $RunnerRoot 'run.cmd') -WorkingDirectory $RunnerRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $Account
# Interactive: the point of the whole exercise. Limited: nothing the tiers do wants administrator, and a
# runner that has it would hand it to every job.
$principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

if ($AutoLogon) {
    $password = Read-Host "password for $Account (stored in the registry in CLEARTEXT)" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password))
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    Set-ItemProperty $winlogon -Name AutoAdminLogon -Value '1'
    Set-ItemProperty $winlogon -Name DefaultUserName -Value $env:USERNAME
    Set-ItemProperty $winlogon -Name DefaultDomainName -Value $env:USERDOMAIN
    Set-ItemProperty $winlogon -Name DefaultPassword -Value $plain
    Step 'automatic logon enabled — this machine now signs in without anyone present.'
}

Step 'starting it...'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 15

# ── verify the one property that matters ─────────────────────────────────────────────────────────────────────
$listener = Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue
if (-not $listener) {
    Die "the listener did not start. Run $RunnerRoot\run.cmd by hand to see what it says."
}
$sessions = @($listener | ForEach-Object { $_.SessionId })
if ($sessions -contains 0) {
    Die 'the listener is in session 0 — something re-created the service. The desktop tiers cannot pass like this.'
}
Write-Host ''
Step "ready: listener in session $($sessions -join ', '), as $Account."
Step "it starts again at every sign-in$(if ($AutoLogon) { ', and this machine signs in on its own' } else { " — after an unattended reboot it waits for one (-AutoLogon changes that, at the cost of a stored password)" })."
Step 'the tiers reconcile everything else about this machine themselves; nothing here needs doing again.'
