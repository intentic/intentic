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

  A LOGON TASK, BUT NOT A CONSOLE SOMEBODY IS MINDING. "Not a service" is a statement about the SESSION, and it
  is often read as a statement about attendance — so the runner ends up being whatever `run.cmd` somebody
  double-clicked, in a console window on somebody's desktop, which dies with the window, dies with the machine,
  and comes back when a person remembers. Nothing about the desktop requirement asks for that. The task this
  registers is unattended in every way a service is except the one that matters to the tiers:

    • no window — the listener is started through a hidden host, so there is nothing on the desktop to close by
      accident and nothing to keep open on purpose;
    • self-healing — a repeating trigger re-runs the task every few minutes, and `IgnoreNew` makes that a no-op
      while the listener is alive. So a crash, a network drop, a failed self-update or an operator who killed it
      is repaired within minutes, by the machine, with nobody signed in. Task Scheduler's own restart-on-failure
      only fires for what it CALLS a failure, and a listener that exited 0 is not one;
    • it comes back by itself after a reboot, given -AutoLogon, and does not wait out a sleep, given -KeepAwake.

  The last two are switches rather than defaults because each one trades something real away (a stored password,
  a machine-wide power policy) and only a dedicated CI box should make that trade.

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
  # On a box that exists to be this runner and nothing else: signs itself in after a reboot, never sleeps.
  ./setup-windows-runner.ps1 -Url https://github.com/intentic -Token <token> -AutoLogon -KeepAwake

.EXAMPLE
  # Re-run against an already-registered machine to repair its session, no token needed. Also what turns a
  # runner somebody had started by hand, in a console window, into the unattended task described above.
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
    # Stop this machine sleeping on mains power. OFF by default because it is a machine-wide power policy, and
    # this script otherwise changes none — but a runner on a box that sleeps is a runner that is OFFLINE for as
    # long as nobody touches the keyboard, which from GitHub's side is indistinguishable from a broken one: jobs
    # queue against a label no machine is answering. Worth it on a dedicated CI box, not on somebody's laptop.
    [switch]$KeepAwake,
    # Repair an existing registration's session without reconfiguring it. No -Url/-Token needed.
    [switch]$Repair,
    # Proceed even though this runner is in the middle of a job. Off by default because the alternative is
    # somebody's red CI run: replacing the listener takes down the job it is executing, and what that looks like
    # on the Actions page is a step failing for a reason the log cannot explain — every assertion passing, then
    # the process gone. Written after doing exactly that to a run that was passing.
    [switch]$Force
)
# Not 'Stop': this script probes with native commands and branches on what they answer. A probe exiting
# non-zero is the ANSWER here, not a failure.
$ErrorActionPreference = 'Continue'

$TaskName = 'GitHub Actions Runner'
$Account = "$env:USERDOMAIN\$env:USERNAME"
# How often the watchdog trigger re-runs the task. It is a no-op while the listener is alive (the task's
# multiple-instance policy is IgnoreNew), so this is not a restart interval — it is the WORST CASE between the
# listener dying and it being back, and the only cost of a small number is a scheduler wake-up.
$WatchdogMinutes = 3

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
#
# AND THEN THE TASK, which is the only one of the three that answers about a runner that is NOT RUNNING. That is
# not a corner: it is the machine this repair is most often aimed at. A runner started in a console window and
# then closed leaves no service and no listener, so the two sources above both come back empty and the bare
# `-Repair` the doctor prints falls back to this script's default root and dies on "no runner to repair" —
# pointing at C:\actions-runner on a machine whose runner is at C:\runner, which is the same failure the comment
# above describes, reached by the other road. The task holds the path in its action, and the task survives the
# listener dying, which is exactly the state worth reading it in.
#
# One parent, not two: this action names <root>\run.cmd rather than <root>\bin\<exe>, and it names it either
# bare (as `Execute`, the shape registered before the hidden host) or inside the -Command of a PowerShell host.
# Matched by pattern for that reason, and quotes are excluded from the path so the quoted form yields the path
# rather than everything up to the end of the argument.
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
    $found = $null
    if ($image) { $found = Split-Path (Split-Path $image -Parent) -Parent }
    if (-not $found) {
        $registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($registered) {
            $command = ($registered.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' '
            $named = [regex]::Match($command, '([A-Za-z]:\\[^"'']*?)\\run\.cmd')
            if ($named.Success) { $found = $named.Groups[1].Value }
        }
    }
    # Asserted rather than assumed: a directory with no run.cmd in it is not a runner root, and adopting one
    # silently would point the repair at nothing while reporting that it had found the installation.
    if ($found -and (Test-Path (Join-Path $found 'run.cmd'))) {
        $RunnerRoot = $found
        Step "found the runner at $RunnerRoot"
    }
}

# ── the runner package ───────────────────────────────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $RunnerRoot 'run.cmd'))) {
    if ($Repair) {
        Die "no runner to repair: nothing at $RunnerRoot, and no service, listener or '$TaskName' task on this machine pointed anywhere else. Pass -RunnerRoot if it is installed somewhere this could not see."
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

# ── is this runner in the middle of somebody's CI run? ───────────────────────────────────────────────────────
# ASKED BEFORE ANYTHING IS TOUCHED, because every destructive step below — removing the service, re-registering
# the task, replacing the listener — takes down a job in flight, and the way that surfaces is the problem: the
# job's current step dies, so the Actions page shows a step failing after every assertion in it passed, with a
# process that simply stopped and no line in the log naming a cause. It cost a red run on a passing commit to
# learn that, and the person reading that log has no way to connect it to a command somebody ran on the box.
#
# `Runner.Worker.exe` is the per-job process the listener spawns, so its presence IS "a job is executing" —
# more precisely than the task's state, which is Running whenever the listener is up and idle.
$working = @(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'" -ErrorAction SilentlyContinue)
if ($working.Count -gt 0) {
    if (-not $Force) {
        Die ("this runner is executing a job right now (Runner.Worker.exe pid $(($working | ForEach-Object { $_.ProcessId }) -join ', ')). " +
            'Repairing it would fail that job at whatever step it had reached, and the failure would name the step rather than this command. ' +
            'Wait for the job to finish, or re-run with -Force.')
    }
    Step 'a job is in flight and -Force was given: it will fail, and be retried against the runner that comes back.'
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

# NO WINDOW ON THE DESKTOP. `run.cmd` is a console program, so a task that executes it directly puts a cmd
# window on the session's desktop for as long as the runner lives — and that window becomes the runner as far as
# anybody looking at the machine is concerned: closing it stops CI, and a person who does not know that closes
# it. Started through a hidden PowerShell host instead, the console is never mapped; the child `cmd.exe` that
# run.cmd is inherits that hidden console rather than creating one of its own.
#
# `run.cmd` and not `Runner.Listener.exe`: run.cmd is the loop that handles the runner's own self-update, which
# exits with a distinguished code expecting to be restarted. Bypassing it works right up to the first update.
#
# Single-quoted inside the -Command, so a $RunnerRoot with a space in it survives; the doubling is PowerShell's
# own escape for a literal quote, for the path nobody should have but somebody will.
$launcher = "& '" + ($RunnerRoot -replace "'", "''") + "\run.cmd'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$launcher`"" `
    -WorkingDirectory $RunnerRoot

# TWO TRIGGERS, AND THE SECOND ONE IS WHY THIS IS UNATTENDED. At logon for the obvious reason. Then a repeating
# trigger for everything that stops a listener without anybody logging out: a crash, a dropped network the
# listener gave up on, a self-update that failed halfway, an operator's Ctrl-C, a job that took the process down
# with it. `-MultipleInstances IgnoreNew` is what makes that safe rather than a fork bomb — while the task is
# running, every repetition is dropped, so this fires into the void every few minutes and costs nothing, and the
# one time it matters the runner is back within $WatchdogMinutes with nobody present.
#
# `-RestartCount` below stays as the FAST path: Task Scheduler restarts a failed task within a minute. It is not
# a substitute, because it only fires for what the scheduler calls a failure, and a listener that exited zero —
# which is what a graceful stop and most self-update handoffs look like — is not one. That is the gap the
# repetition closes, and it is the gap that had this machine needing a person.
#
# NO -RepetitionDuration, AND THAT IS THE SPELLING OF "FOREVER". An empty duration is how the Task Scheduler
# schema says indefinite, and omitting the parameter is what produces it.
#
# The obvious-looking alternative is wrong and fails LATE, which is why it is written down here. Docs point at
# [TimeSpan]::MaxValue for an indefinite duration; PowerShell accepts it, silently clamps it to the largest
# duration it can render (P99999999DT23H59M59S), hands back a trigger object that inspects perfectly — and then
# Register-ScheduledTask rejects that value as out of range. `New-ScheduledTask` does NOT validate against the
# schema, so every check short of a real registration passes it. The failure is at the one step that matters.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $Account
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes)

# Interactive: the point of the whole exercise. Limited: nothing the tiers do wants administrator, and a
# runner that has it would hand it to every job.
$principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Limited
# -StartWhenAvailable: a trigger whose time passed while the machine was asleep or off is otherwise SKIPPED, not
# deferred, so without it the machine coming back is not itself enough to bring the runner back.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
# -ErrorAction Stop ON THIS ONE CALL, against the file-wide 'Continue'. That preference is set for the PROBES
# above, where a non-zero exit is the answer being sought — and it turned this registration into the worst kind
# of failure: Task Scheduler refused the XML, the script carried on past two screens of red, the previous task
# was left in place untouched, and the summary at the bottom then described the unattended runner it had just
# failed to create. A registration is not a probe. It either happened or this script has nothing to report.
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atLogon, $watchdog) `
        -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
} catch {
    Die "could not register the '$TaskName' task, so this machine is unchanged: $($_.Exception.Message)"
}

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

if ($KeepAwake) {
    # A SLEEPING RUNNER IS AN OFFLINE RUNNER, and from GitHub's side that is indistinguishable from a broken
    # one: jobs naming `windows-desktop` queue against a label nothing is answering, with no error anywhere to
    # read. Mains power only — on battery this machine is somebody's laptop and should still be allowed to
    # sleep. The monitor is left alone deliberately: a blanked screen keeps every window mapped, so it costs the
    # tiers nothing, and turning it off is not this script's business.
    Step 'stopping this machine sleeping on mains power...'
    & powercfg /change standby-timeout-ac 0 | Out-Null
    & powercfg /change hibernate-timeout-ac 0 | Out-Null
}

# ── one listener, and it is the task's ───────────────────────────────────────────────────────────────────────
# The machine this repairs is usually one where somebody started the runner BY HAND — `run.cmd` in a console
# window, which is what makes "is CI working?" a question about whether a window is still open somewhere. That
# listener holds the registration, and GitHub allows one session per registered runner: leave it alive and the
# task starts, is refused as already in use, and exits — a repair that reports success and changed nothing.
#
# So whatever started the old one, it goes first — and the hosts go before the listener, because run.cmd is a
# loop and killing the listener under a live loop only gets it restarted.
#
# FOUND BY ANCESTRY, NOT BY STRING MATCH, and the difference is somebody else's process. "A shell whose command
# line mentions the runner root" reads plausible and over-matches badly: it hits any terminal, editor or script
# that happens to name that path, including — measured on the machine this was written for — the very command
# doing the matching, whose own text contained it. Excluding this process does not save it, because the next
# shell along belongs to a person.
#
# A live listener's PARENT CHAIN is the exact answer instead: the cmd.exe that is run.cmd, and the host that
# launched it. Walked up from each listener and stopped at the first non-shell, so the chain ends at Task
# Scheduler's svchost, or at explorer.exe for one somebody double-clicked, rather than climbing to the root of
# the process tree. Nothing that is not hosting a listener is touched.
#
# A runner whose listener is already dead needs none of this: what the new task collides with is the GitHub-side
# session, and that is held by the listener, not by a console left open above it.
#
# It can take a running job down with it. That is the right trade for a command somebody ran deliberately to
# repair this machine, and the job is retried against the runner that comes back.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
$shells = @('cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe')
$listeners = @(Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue)
$hosting = [System.Collections.Generic.List[object]]::new()
foreach ($live in $listeners) {
    $walk = Get-CimInstance Win32_Process -Filter "ProcessId=$($live.ParentProcessId)" -ErrorAction SilentlyContinue
    while ($walk -and $walk.ProcessId -ne $PID -and $shells -contains $walk.Name) {
        $hosting.Add($walk)
        $walk = Get-CimInstance Win32_Process -Filter "ProcessId=$($walk.ParentProcessId)" -ErrorAction SilentlyContinue
    }
}
foreach ($stale in $hosting) { Stop-Process -Id $stale.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($live in $listeners) { Stop-Process -Id $live.ProcessId -Force -ErrorAction SilentlyContinue }
if ($listeners.Count -gt 0) { Step "stopped $($listeners.Count) running listener(s), and $($hosting.Count) host process(es) above them." }

Step 'starting it...'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 15

# ── verify the properties that matter ────────────────────────────────────────────────────────────────────────
$listener = Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue
if (-not $listener) {
    Die "the listener did not start. Run $RunnerRoot\run.cmd by hand to see what it says."
}
$sessions = @($listener | ForEach-Object { $_.SessionId })
if ($sessions -contains 0) {
    Die 'the listener is in session 0 — something re-created the service. The desktop tiers cannot pass like this.'
}

# READ THE TASK BACK, rather than trusting that asking for a shape produced it. A running listener is NOT
# evidence of this script's work: `Start-ScheduledTask` starts whatever task is registered, so a listener in
# session 1 is exactly as consistent with the old console-window task as with the new one — which is how a
# refused registration came to be reported as an unattended runner. Every claim the summary below makes is
# asserted here first, off the registered task, and the claims are what the outage was about.
$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $registered) {
    Die "the '$TaskName' task is not registered, so nothing supervises this runner."
}
$hosted = ($registered.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' '
if ($hosted -notmatch 'WindowStyle\s+Hidden') {
    Die "the task still runs the listener in a visible console ($hosted). Re-run this script; if it persists, the registration was refused."
}
$repetition = ($registered.Triggers | Where-Object { $_.Repetition.Interval } | Select-Object -First 1).Repetition.Interval
if (-not $repetition) {
    Die 'the task carries no repeating trigger, so nothing would restart this listener if it died. The registration did not take.'
}
Write-Host ''
Step "ready: listener in session $($sessions -join ', '), as $Account, with no window on the desktop."
Step "it is checked every $WatchdogMinutes minutes ($repetition, read back off the registered task) and restarted if it has stopped — nothing to keep open, nothing to babysit."
Step "it starts again at every sign-in$(if ($AutoLogon) { ', and this machine signs in on its own' } else { " — after an unattended reboot it waits for one (-AutoLogon changes that, at the cost of a stored password)" })."
if (-not $KeepAwake) {
    Step 'this machine may still SLEEP, and a sleeping runner is an offline runner as far as GitHub is concerned (-KeepAwake changes that, at the cost of a machine-wide power policy).'
}
Step 'the tiers reconcile everything else about this machine themselves; nothing here needs doing again.'
