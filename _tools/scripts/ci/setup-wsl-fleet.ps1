<#
.SYNOPSIS
  Make the Linux CI fleet come back on its own. Companion to docs/ci-runner.md, which describes the six runner
  processes; this script is the one thing about them that is a WINDOWS fact, because on this host the fleet
  lives inside a WSL2 distribution.

  THE GAP THIS CLOSES. The six runners are systemd units and they are `enabled`, so they start when the distro
  boots. Nothing boots the distro. WSL2 has no "start at logon" of its own: a distribution runs because
  something invoked `wsl.exe`, and stops when the host reboots or when anything issues `wsl --shutdown` --
  which Docker Desktop does to the whole utility VM on its own restarts and updates. So the fleet's uptime was
  a side effect of somebody happening to open a shell.

  AND THE VM SHUTS ITSELF DOWN AFTER SIXTY SECONDS. `vmIdleTimeout` defaults to 60000 ms, so even once the
  distro has been started, WSL powers the VM off a minute after the last client goes away, taking systemd and
  all six listeners with it. Measured here: six runners online, all six offline 30 seconds later, back after
  the next watchdog pass. This script sets `vmIdleTimeout=-1`, because a watchdog against a 60-second timeout
  would leave the fleet down most of the time rather than fix it.

  Measured, on the machine this was written for: the host rebooted at 04:29 on 26 August and signed itself
  back in a minute later, so the Windows runner's logon task brought that runner straight back. The distro was
  not started again until a person went looking on the 29th. Six runners offline for three and a half days,
  eight pipelines queued against `[self-hosted, intentic]`, and nothing anywhere reporting an error: a label
  no machine is answering looks exactly like a slow queue.

  DOCKER FIRST, AND THAT ORDER IS THE POINT. The jobs run in containers on the host daemon, which on this
  machine is Docker Desktop reaching into the distro through its WSL integration. Two things follow. A fleet
  that comes up without it fails every job it takes with `docker: command not found` -- which is what the first
  pipeline after the recovery above did, in 90 seconds, on a commit that was fine. And Docker Desktop STARTS
  BY RESTARTING THE WSL VM, so bringing it up second kills the runners mid-job and leaves their sessions
  stranded on GitHub's side ("A session for this runner already exists"). The reconciler waits for the engine
  to answer before it touches the distro, every time, for both reasons.

  AND THE DISK IS THE THIRD WAY, the one the two above cannot see. On 30 August the host volume reached 2.04 GB
  free of 1 TB -- Docker Desktop's docker_data.vhdx at 456 GB and the distro's ext4.vhdx at 188 GB, neither
  bounded by anything. Docker's data disk could not extend, so the engine stopped ANSWERING rather than
  returning an error: `docker version` blocked instead of failing. Every job then hung on "Initialize
  containers" and was killed at its own timeout-minutes, which Actions records as `cancelled` -- six pipelines
  in a row, while the six listeners stayed online and GitHub showed a healthy fleet.

  The reconciler was running throughout and did not save it, for two reasons this script now fixes. Its probe
  was an unbounded `docker version`, so every pass parked on the call: the 3-minute repetitions behind it were
  refused by IgnoreNew, the 15-minute ExecutionTimeLimit killed each pass before it reached a single log line,
  and Task Scheduler ended the pass without ending the `docker.exe` it was blocked on -- 46 of those piled up in
  twelve hours. And nothing measured the disk. Nothing inside the distro could have: WSL's vhdx is sparse, so
  the distro's `df` read 680 GB free while Windows had 2.04. That number is only true on the host, which is
  where this script runs.

  AND THE FOURTH WAY WAS THIS SCRIPT. On 4 September two CI jobs pushed multi-GB images to ghcr.io at once and
  the engine stopped answering `docker version` inside the reconciler's 20-second bound -- saturated, not dead.
  A pass waited its 90 seconds, called it dead, and killed Docker Desktop, which restarts the WSL VM the six
  runners live in: both pushes died in the same second (21:27:19), every step after them read "Cannot connect
  to the Docker daemon", and neither job's log named this machine. -Restart has always refused to take the VM
  down while a job is executing; the reconciler was doing exactly that every three minutes without asking. It
  asks now -- and defers rather than vetoes, because a job wedged on a genuinely dead engine would otherwise
  hold the repair off for the length of its own timeout.

  WHAT IT REGISTERS. A logon task with a repeating trigger, the same shape setup-windows-runner.ps1 uses for
  the Windows runner and for the same reasons: at logon for the reboot, every few minutes for everything that
  takes the fleet down without anybody logging out. The action is a reconciler, not a supervisor -- it looks
  at the machine, fixes what is not the way it should be, and exits.

  Unelevated. Registering a task for the CURRENT user needs no administrator, unlike the named-principal
  registration setup-windows-runner.ps1 performs, so this can be run from an ordinary shell on the CI box.

  ASCII ONLY, DELIBERATELY. Windows PowerShell 5.1 -- still what an elevated "PowerShell" window is on a stock
  Windows 11 -- reads a BOM-less file as ANSI, which turns a non-ASCII character in a string into a byte it may
  take for a closing quote. setup-windows-runner.ps1 solves that by carrying a UTF-8 BOM it must never lose.
  This file solves it by having nothing to encode.

.EXAMPLE
  # On the CI host, from an ordinary PowerShell. Idempotent: this is also how you repair it.
  ./setup-wsl-fleet.ps1

.EXAMPLE
  # First run on a host that has never had vmIdleTimeout set: WSL reads .wslconfig only when the VM starts, so
  # the setting is inert until one does. Refuses while a job is executing.
  ./setup-wsl-fleet.ps1 -Restart

.EXAMPLE
  # A host whose distribution is named something else.
  ./setup-wsl-fleet.ps1 -Distro ubuntu

.EXAMPLE
  # Report what the machine looks like and change nothing.
  ./setup-wsl-fleet.ps1 -Check
#>
param(
    # The WSL2 distribution the six runner units live in.
    [string]$Distro = 'archlinux',
    # The systemd units to hold up, as `systemctl` accepts them. The runner's own svc.sh names them this way.
    [string]$UnitPattern = 'actions.runner.*.service',
    # How often the watchdog trigger re-runs the reconciler. Not a restart interval -- a healthy pass is a few
    # seconds of probing and changes nothing -- so this is the WORST CASE between the fleet going down and it
    # being back.
    [int]$WatchdogMinutes = 3,
    # How long the engine readiness probe may take before a pass calls the engine dead. This is a BOUND, not a
    # patience setting: a wedged Docker Desktop does not fail `docker version`, it never returns it, so without
    # a cap the probe is what parks the pass forever. See the reconciler's own section 1.
    [int]$EngineProbeSeconds = 20,
    # How long the engine may go on not answering, with jobs executing, before a pass restarts Docker Desktop
    # anyway. A restart takes the WSL VM with it and fails every job in flight, so a busy fleet DEFERS one --
    # but only this long: a job wedged on a genuinely dead engine holds its runner until its own
    # timeout-minutes, and an unconditional "never while busy" would be a wedge nothing heals for an hour.
    [int]$EngineGraceMinutes = 30,
    # Free space on the host volume, in GB, under which a pass reclaims rebuildable docker state. Twice this is
    # only reported; half of it takes the whole build cache rather than the stale part.
    [int]$LowDiskGb = 60,
    # A GUI-subsystem stub, so the reconciler never maps a window. Discovered if not passed; see the block
    # below for why `powershell -WindowStyle Hidden` is not the answer on Windows 11.
    [string]$LauncherPath,
    # Leave Docker Desktop's own start-at-logon setting alone.
    [switch]$NoDockerAutoStart,
    # Leave %USERPROFILE%\.wslconfig alone. Only do this if something else owns that file: without
    # `vmIdleTimeout` the VM powers itself off a minute after the fleet goes quiet. See the block below.
    [switch]$NoIdleTimeout,
    # Restart the WSL VM at the end, which is what makes a NEW .wslconfig take effect. Refuses while a runner
    # is executing a job, because restarting the VM fails that job at whatever step it had reached.
    [switch]$Restart,
    # Restart the VM even though a runner is executing a job.
    [switch]$Force,
    # Probe and report; register nothing, start nothing, change no setting.
    [switch]$Check
)
# Not 'Stop': this script probes with native commands and branches on what they answer. A probe exiting
# non-zero is the ANSWER here, not a failure.
$ErrorActionPreference = 'Continue'

# wsl.exe writes UTF-16LE to a pipe by default, which PowerShell reads as text with a NUL between every
# character: "archlinux" comes back as "a`0r`0c`0h..." and every comparison against it fails, quietly and for a
# reason nothing in the output shows. WSL_UTF8 is the supported switch for that, and it is set before the first
# probe rather than worked around at each one.
$env:WSL_UTF8 = '1'

$TaskName = 'Intentic CI Fleet'
$Root = Join-Path $env:LOCALAPPDATA 'intentic\ci-fleet'
$Reconciler = Join-Path $Root 'reconcile.ps1'
$LogPath = Join-Path $Root 'fleet.log'
# The launcher's own capture of the child's stdout, and it is a SEPARATE file on purpose: pointed at fleet.log
# it appends every line the reconciler already wrote there itself, so the log a person reads shows each event
# twice and reads like the watchdog ran twice.
$LaunchLog = Join-Path $Root 'launch.log'
# When the engine STOPPED answering, written by the pass that first found it unready and removed by the first
# pass that finds it healthy again. A file rather than a variable because every pass is a new process, and the
# question the engine-restart guard asks -- "how long has this outage been going on" -- spans passes.
$UnreadySince = Join-Path $Root 'engine-unready-since.txt'
$DockerSettings = Join-Path $env:APPDATA 'Docker\settings-store.json'
$WslConfig = Join-Path $env:USERPROFILE '.wslconfig'

function Step($message) { Write-Host "intentic: $message" }
function Warn($message) { Write-Host "intentic: $message" -ForegroundColor Yellow }
function Die($message) {
    Write-Host "intentic: $message" -ForegroundColor Red
    exit 1
}

# -- is this the machine this script is about? ----------------------------------------------------------------
# Asserted rather than assumed. Registering a watchdog for a distribution that does not exist would produce a
# task that fires every few minutes forever, fails every time, and reports a fleet that is being looked after.
$installed = @(& wsl.exe -l -q 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
if ($LASTEXITCODE -ne 0 -and -not $installed) { Die 'wsl.exe answered nothing -- WSL is not installed on this machine, so there is no Linux fleet here to hold up.' }
if ($installed -notcontains $Distro) {
    Die "no WSL distribution named '$Distro' on this machine (found: $($installed -join ', ')). Pass -Distro with the right name."
}

# -- the units, read off the distro rather than counted from the docs -----------------------------------------
# docs/ci-runner.md says six, and it says to re-derive that number rather than trust it. The same applies here
# with more force: this list is what the watchdog will hold up every three minutes for the life of the machine.
# Starting the distro to ask is not a side effect worth avoiding -- it is the first half of what this script is
# for.
Step "asking $Distro which runner units it carries..."
$unitList = & wsl.exe -d $Distro -e systemctl list-unit-files $UnitPattern --no-pager --plain --no-legend 2>$null
$units = @($unitList | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ } |
    ForEach-Object { ($_ -split '\s+')[0] })
if (-not $units) {
    Die "no units matching '$UnitPattern' in $Distro. Register the runners first -- docs/ci-runner.md has the config.sh and svc.sh commands -- then run this."
}
Step "found $($units.Count): $($units -join ', ')"

# A unit that is not `enabled` does not start when the distro boots, and the watchdog below would then be the
# ONLY thing starting it -- a fleet that takes up to $WatchdogMinutes to appear after every reboot, for a
# reason nothing reports. Fixed here rather than reported, because `svc.sh install` already meant to do it.
$disabled = @($unitList | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ -and $_ -notmatch '\senabled\s' } |
    ForEach-Object { ($_ -split '\s+')[0] })
if ($disabled -and -not $Check) {
    Step "enabling $($disabled.Count) unit(s) that would not have started at boot: $($disabled -join ', ')"
    foreach ($unit in $disabled) { & wsl.exe -d $Distro -u root -e systemctl enable $unit 2>&1 | Out-Null }
}

# -- the windowless launcher ----------------------------------------------------------------------------------
# The reconciler runs every $WatchdogMinutes for the life of this machine, and this host is also the one whose
# desktop tiers assert on window titles: a console window appearing on it every three minutes is a flake
# generator, not a cosmetic problem.
#
# `powershell -WindowStyle Hidden` DOES NOT HOLD on a current Windows 11, and _devices/win-launcher/README.md
# has the measurement: with Windows Terminal as the default console host, the hidden flag hides the console the
# PowerShell host owns while the window on the desktop belongs to WindowsTerminal.exe, which never gets the
# hint. Only a GUI-subsystem parent starting the child with CREATE_NO_WINDOW maps nothing, which is what
# intentic-launch.exe is.
#
# DISCOVERED, NOT DOWNLOADED. setup-windows-runner.ps1 fetches this stub from the latest release; that asset is
# not published there today, so a download would be a hard failure in the middle of a repair. Every intentic
# machine has a copy under the host install, which is the same binary built from _devices/win-launcher.
if (-not $LauncherPath) {
    $LauncherPath = @(
        (Join-Path $env:USERPROFILE '.intentic\host\bin\intentic-launch.exe'),
        'C:\runner\intentic-launch.exe',
        'C:\actions-runner\intentic-launch.exe'
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ($LauncherPath) {
    Step "windowless launcher: $LauncherPath"
} else {
    Warn 'no intentic-launch.exe found on this machine, so the reconciler falls back to a hidden PowerShell host -- which on Windows 11 with Windows Terminal still maps a window for a moment every few minutes. Pass -LauncherPath, or install the intentic host, to remove it.'
}

# -- the reconciler ---------------------------------------------------------------------------------------------
# Generated rather than shipped beside the task, so that re-running this script is what updates it, and so the
# values it closes over (the distro, the units, the timeouts) are decided once, here, by the checks above.
$reconcilerBody = @"
# GENERATED by _tools/scripts/ci/setup-wsl-fleet.ps1 -- edit that file and re-run it, not this one.
#
# One pass of "is the Linux CI fleet the way it should be". Run at logon and every few minutes by the
# '$TaskName' scheduled task. Probes first and acts only on what is wrong, so the healthy pass is a few seconds
# and changes nothing.
`$ErrorActionPreference = 'Continue'
# wsl.exe pipes UTF-16LE without this, and every string comparison below then fails against a name with a NUL
# between every character.
`$env:WSL_UTF8 = '1'
`$Distro = '$Distro'
`$Units = @($(($units | ForEach-Object { "'$_'" }) -join ', '))

function Say(`$m) {
    `$line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), `$m
    Write-Host `$line
    Add-Content -Path '$LogPath' -Value `$line -ErrorAction SilentlyContinue
}

# EVERY PASS SAYS SOMETHING, including the ones that change nothing. A watchdog that only writes when it acts
# leaves a healthy machine and a watchdog that stopped running looking identical -- an empty log -- and "nothing
# anywhere was reporting an error" is the whole reason this file exists. One line per pass is also what makes
# the log answer "when did the fleet last go down", which is the question asked after the fact.

# -- 0. the disk, measured where the number is true --------------------------------------------------------------
# ON THE HOST, NEVER FROM INSIDE THE DISTRO, and that distinction is the whole reason this section exists. WSL's
# vhdx is sparse, so the distro's `df` reports its VIRTUAL size: on 30 August it read 680 GB free while Windows
# had 2.04 GB. Every check that could have caught this from inside the fleet was reading a number that cannot go
# down. Two files carry it -- Docker Desktop's docker_data.vhdx and the distro's own ext4.vhdx, 456 GB and 188 GB
# that day -- and until section 2 below, nothing on this machine bounded either.
#
# WRITTEN FIRST, BEFORE ANYTHING THAT CAN BLOCK, so a pass that dies later still leaves the number that explains
# why, stamped at the moment it was true. The 30 August log simply stops at 06:53:28, and the free-space figure
# that was the entire answer had to be read off the machine twelve hours after the fact.
`$LowDiskGb = $LowDiskGb
function HostFreeGb {
    try {
        `$root = [System.IO.Path]::GetPathRoot(`$env:LOCALAPPDATA)
        return [math]::Round((New-Object System.IO.DriveInfo(`$root)).AvailableFreeSpace / 1GB, 1)
    } catch { return -1 }
}
`$freeGb = HostFreeGb
if (`$freeGb -lt 0) { Say 'disk: could not read free space on this host' }
elseif (`$freeGb -lt (`$LowDiskGb / 2)) { Say "disk: `$freeGb GB free -- CRITICAL, under half the `$LowDiskGb GB floor" }
elseif (`$freeGb -lt `$LowDiskGb) { Say "disk: `$freeGb GB free -- UNDER the `$LowDiskGb GB floor" }
elseif (`$freeGb -lt (`$LowDiskGb * 2)) { Say "disk: `$freeGb GB free -- approaching the `$LowDiskGb GB floor" }
else { Say "disk: `$freeGb GB free" }

# -- 1. the engine, BEFORE the distro --------------------------------------------------------------------------
# Docker Desktop starts by restarting the WSL utility VM. Bringing it up after the fleet therefore kills every
# runner mid-job and strands their sessions on GitHub's side; bringing the fleet up without it at all means
# every job that lands fails on "docker: command not found". Both were observed on this machine. So the engine
# is settled first and the distro is not touched until it answers.
`$dockerExe = @(
    'C:\Program Files\Docker\Docker\resources\bin\docker.exe',
    'C:\Program Files\Docker\Docker\resources\docker.exe'
) | Where-Object { Test-Path `$_ } | Select-Object -First 1
`$desktopExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

# NO PROBE HERE MAY BLOCK, and that is the lesson of 30 August. A wedged engine does not FAIL `docker version` --
# it never answers it, and an unbounded call is then what parks the pass forever. WaitForEngine's deadline was
# never the bound it looked like: the LOOP was bounded and the call inside it was not, so the pass never reached
# a Say, the 3-minute repetitions behind it were refused by IgnoreNew (0x800710E0), the 15-minute
# ExecutionTimeLimit killed it, and the `docker.exe` it was blocked on outlived the kill -- 46 of them in twelve
# hours. The supervision was gone and its log was empty, which is this file's own failure mode reached from the
# inside.
#
# So every external command goes through here, and a timeout is an ANSWER (`$null`) rather than a wait.
function RunBounded(`$exe, `$arguments, `$seconds) {
    `$psi = New-Object System.Diagnostics.ProcessStartInfo
    `$psi.FileName = `$exe
    `$psi.Arguments = `$arguments
    `$psi.UseShellExecute = `$false
    `$psi.RedirectStandardOutput = `$true
    `$psi.RedirectStandardError = `$true
    `$psi.CreateNoWindow = `$true
    try { `$p = [System.Diagnostics.Process]::Start(`$psi) } catch { return `$null }
    if (-not `$p.WaitForExit(`$seconds * 1000)) {
        # KILLED, not abandoned. The 46 strays were grandchildren Task Scheduler had no reason to end; a probe
        # that cleans up after itself is what stops them accumulating in the first place.
        try { `$p.Kill() } catch { }
        return `$null
    }
    # Read AFTER the wait, which is only safe because every command here produces a few bytes. One with real
    # output would deadlock on a full pipe buffer and needs the async form instead.
    return @{ Code = `$p.ExitCode; Out = `$p.StandardOutput.ReadToEnd() }
}

# "docker version" is the readiness probe, and the PROCESS LIST IS NOT. Docker Desktop's own processes are up
# long before the engine behind them takes a request, so the process list says yes too early -- and, worse, it
# keeps saying yes when the engine is dead.
`$engineBlocked = `$false
function EngineReady {
    if (-not `$dockerExe) { return `$false }
    `$r = RunBounded `$dockerExe 'version --format {{.Server.Version}}' $EngineProbeSeconds
    # A TIMEOUT AND AN ERROR ARE BOTH "not ready", but only one of them is worth naming in the log: an engine
    # that blocks is the shape that took the fleet down, and an engine that answers non-zero is the ordinary
    # not-up-yet.
    if (`$null -eq `$r) { `$script:engineBlocked = `$true; return `$false }
    return `$r.Code -eq 0
}
function WaitForEngine(`$minutes) {
    # Bounded, always -- and now bounded in both places. A pass that waits forever holds the task 'running', and
    # IgnoreNew then swallows every watchdog repetition behind it: the supervision would go quiet exactly when it
    # is most needed.
    `$deadline = (Get-Date).AddMinutes(`$minutes)
    while (-not (EngineReady) -and (Get-Date) -lt `$deadline) { Start-Sleep -Seconds 5 }
    return (EngineReady)
}
function DockerProcesses {
    return @(Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build', 'com.docker.dev-envs', 'com.docker.extensions' -ErrorAction SilentlyContinue)
}

# IS THE FLEET EXECUTING ANYTHING RIGHT NOW -- the question this section did not ask, and the only one that
# separates "heal a dead engine" from "kill six running jobs". Restarting Docker Desktop restarts the WSL
# utility VM the fleet lives in, which is the same act -Restart has refused to perform while a job is executing
# since the day it was written; the reconciler was performing it every three minutes with no such guard.
#
# WHAT THAT COST, on 4 September: CI run 33918156956 had two jobs pushing multi-GB images to ghcr.io, which is
# enough to keep the engine from answering `docker version` inside the 20-second bound above. A pass spent its
# 90 seconds, called the engine dead and killed Docker Desktop -- and at 21:27:19 BOTH pushes died in the same
# second, `unexpected EOF` in one and exit 255 in the other, with every step after them reporting "Cannot
# connect to the Docker daemon". Nothing in either job's log named this machine. From here a SATURATED engine
# and a DEAD one look identical, and a busy fleet is the thing that tells them apart.
#
# Runner.Worker is the per-job process a listener spawns, so its presence IS "a job is executing" -- the same
# probe -Restart uses, for the same reason.
function BusyRunners {
    # `-l --running -q` is the one probe here that does NOT start the distro, and a distro that is not running
    # is executing nothing by definition.
    `$up = @(& wsl.exe -l --running -q 2>`$null | ForEach-Object { (`$_ -replace "``0", '').Trim() } | Where-Object { `$_ })
    if (`$up -notcontains '$Distro') { return 0 }
    # pgrep exits 1 when nothing matches, so the COUNT it prints is the answer and the exit code is not.
    `$r = RunBounded 'wsl.exe' '-d $Distro -e pgrep -c Runner.Worker' $EngineProbeSeconds
    # A probe that timed out means the DISTRO is not answering either, which is not a fleet with work in flight
    # -- and reading "unknown" as busy is how the healing path below would never run again.
    if (`$null -eq `$r) { return 0 }
    `$n = (`$r.Out -replace "``0", '').Trim()
    if (`$n -match '^\d+`$') { return [int]`$n }
    return 0
}
function ClearUnready { Remove-Item '$UnreadySince' -Force -ErrorAction SilentlyContinue }

if (`$dockerExe -and -not (EngineReady)) {
    if ((DockerProcesses).Count -eq 0) {
        if (Test-Path `$desktopExe) {
            Say 'docker engine not answering and Docker Desktop is not running -- starting it'
            Start-Process `$desktopExe -ErrorAction SilentlyContinue
        }
        WaitForEngine 4 | Out-Null
    } else {
        # UP BUT NOT ANSWERING GETS A RESTART, NOT MORE WAITING -- unless the fleet is working, which is the
        # guard below and the one thing this branch may not do without. And that is a distinction this file learned the
        # hard way. `wsl --shutdown` -- which this script's own -Restart does, and which a WSL update does on its
        # own -- takes Docker Desktop's `docker-desktop` distro out from under it. Its Windows processes stay
        # alive, the app is still on screen, and every request to the engine then answers 500 Internal Server
        # Error, forever: Docker Desktop does not notice and does not heal. A reconciler that treats
        # "processes exist" as "it is coming
        # up" waits out its deadline every pass and never fixes anything, which is a fleet that stays down with a
        # watchdog running over the top of it saying nothing is wrong.
        #
        # The 90 seconds first is what keeps this from fighting a Docker Desktop that is legitimately still
        # booting -- the engine takes about half a minute from a cold start on this machine.
        if (-not (WaitForEngine 1.5)) {
            # HOW LONG THIS OUTAGE HAS BEEN GOING ON, not how long this pass has waited. Stamped by the first
            # pass that finds the engine unready and cleared by the first that finds it healthy, so a fleet
            # that is merely saturated -- the case above -- never accumulates minutes here.
            `$unreadySince = `$null
            try {
                `$stamp = (Get-Content '$UnreadySince' -ErrorAction Stop | Select-Object -First 1)
                `$unreadySince = [datetime]::Parse(`$stamp, [Globalization.CultureInfo]::InvariantCulture)
            } catch { }
            if (-not `$unreadySince) {
                `$unreadySince = Get-Date
                Set-Content -Path '$UnreadySince' -Value `$unreadySince.ToString('o') -ErrorAction SilentlyContinue
            }
            `$busy = BusyRunners
            `$outage = [int]((Get-Date) - `$unreadySince).TotalMinutes
            if (`$busy -gt 0 -and `$outage -lt $EngineGraceMinutes) {
                # THE LINE THAT WOULD HAVE SAVED RUN 33918156956. Said every pass rather than once, because
                # this is the state a person reads the log to find, and a deferral that logs nothing is
                # indistinguishable from a watchdog that has stopped.
                Say "engine not answering, but `$busy job(s) are executing and the outage is `$outage min -- NOT restarting Docker Desktop: it takes the WSL VM with it and fails them mid-step, and an engine merely saturated by their own image pushes looks exactly like this. Restarts anyway once the outage passes $EngineGraceMinutes min."
                `$restartEngine = `$false
            } else {
                if (`$busy -gt 0) {
                    Say "engine not answering for `$outage min with `$busy job(s) still executing -- restarting anyway: past $EngineGraceMinutes min those jobs are wedged on a dead engine rather than working, and they fail either way"
                }
                `$restartEngine = `$true
            }
        } else { `$restartEngine = `$false }
        if (`$restartEngine) {
            Say 'Docker Desktop is running but its engine has not answered -- restarting it'
            DockerProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
            # The CLI processes a wedged engine is holding open. RunBounded kills the ones this pass starts, so
            # these are only ever leftovers from a pass that predates that bound -- but leaving them is what
            # turned one wedge into 46 processes. Age-guarded, so a `docker` a person is running is never in
            # scope, and the guard reads StartTime defensively because it throws on a process this session
            # cannot open.
            `$strays = @(Get-Process -Name 'docker' -ErrorAction SilentlyContinue |
                Where-Object { try { `$_.StartTime -lt (Get-Date).AddMinutes(-30) } catch { `$false } })
            if (`$strays.Count -gt 0) {
                Say "killing `$(`$strays.Count) docker CLI process(es) left stuck on the dead engine"
                `$strays | Stop-Process -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Seconds 8
            if (Test-Path `$desktopExe) { Start-Process `$desktopExe -ErrorAction SilentlyContinue }
            WaitForEngine 4 | Out-Null
        }
    }
    if (EngineReady) { Say 'docker engine is up'; ClearUnready }
    else { Say "docker engine still not answering`$(if (`$engineBlocked) { ' (the probe TIMED OUT -- it is blocking, not erroring, which is what a full host disk does to it)' }) -- starting the fleet anyway; its container jobs will fail until it does" }
} elseif (`$dockerExe) {
    # AN OUTAGE THAT ENDED ON ITS OWN ends here, and clearing it here is what keeps the grace above honest. The
    # saturated engine this section now waits out never reaches the repair branch at all, so without this line
    # its stamp would outlive it and the NEXT outage would read as half an hour old on its first pass.
    ClearUnready
}
if (-not `$dockerExe) { Say 'no docker CLI on this host -- skipping the engine check' }

# -- 2. the bound on the disk, which is the part that had no owner -----------------------------------------------
# Reclaim what is REBUILDABLE and nothing else. This daemon is shared with the owner's own sandboxes, so nothing
# here removes a tagged image or a volume: `docker image prune` without `-a` takes dangling layers only, and
# BuildKit's cache is rebuilt on demand by the next build that wants it.
#
# The build cache is the half CI creates and nothing evicted. publish-images.sh stands up a `docker-container`
# buildx builder named intentic-cache, and its BuildKit state grows with every image build for the life of the
# machine -- docs/ci-runner.md's "Keeping it bounded" covered turbo, pnpm, cargo, xwin and playwright, and not
# this. That builder lives in the DISTRO's buildx state rather than this host's, so the prune is issued through
# wsl.exe as the distro's default user, whose builder it is; root would prune its own empty default builder and
# report success.
#
# ONLY WITH A LIVE ENGINE, and the other branch is the line that would have ended the last incident in five
# minutes rather than twelve hours.
if (`$freeGb -ge 0 -and `$freeGb -lt `$LowDiskGb) {
    if (EngineReady) {
        `$deep = `$freeGb -lt (`$LowDiskGb / 2)
        `$cacheArgs = if (`$deep) { '-af' } else { '-f --filter until=72h' }
        Say "disk: reclaiming rebuildable docker state (`$(if (`$deep) { 'all build cache' } else { 'build cache older than 72h' }))"
        # A BUDGET, because the pass runs under a 15-minute ExecutionTimeLimit and a prune on a full disk is
        # slow. Whatever does not fit is not lost -- the next pass three minutes later still sees a host under
        # the floor and picks up where this one stopped.
        `$pruneDeadline = (Get-Date).AddMinutes(5)
        foreach (`$cmd in @("buildx prune --builder intentic-cache `$cacheArgs", "builder prune `$cacheArgs", 'image prune -f')) {
            if ((Get-Date) -ge `$pruneDeadline) { Say 'disk: prune budget spent -- the rest waits for the next pass'; break }
            RunBounded 'wsl.exe' "-d `$Distro -- docker `$cmd" 180 | Out-Null
        }
        `$after = HostFreeGb
        Say "disk: `$after GB free after the prune (was `$freeGb)"
    } else {
        # NAMED, because this pairing is the whole of 30 August. A wedged engine on a host this low is wedged
        # BECAUSE the host is this low: docker's data disk cannot extend, and the daemon stops answering rather
        # than returning an error anything upstream could read. Restarting it does not hold, so say so instead
        # of restarting it every three minutes forever.
        Say "disk: `$freeGb GB free AND the engine is not answering -- free space on this host before trusting any restart; the engine is almost certainly wedged on the disk"
    }
}

# -- 3. the distribution -----------------------------------------------------------------------------------------
# This is the whole reason the file exists. WSL2 starts no distribution at boot, so without this the fleet is
# down from the reboot until a person opens a shell.
`$running = @(& wsl.exe -l --running -q 2>`$null | ForEach-Object { (`$_ -replace "``0", '').Trim() } | Where-Object { `$_ })
if (`$running -notcontains `$Distro) {
    Say "`$Distro is not running -- starting it"
    # -u root -e /bin/true: the cheapest thing that boots the distro. With systemd enabled, booting it is what
    # starts the enabled runner units; this process exits immediately and the distro stays up because systemd
    # and the listeners are in it.
    & wsl.exe -d `$Distro -u root -e /bin/true 2>&1 | Out-Null
    Start-Sleep -Seconds 10
}

# -- 4. the units ------------------------------------------------------------------------------------------------
# The runner units carry no Restart= directive, so systemd does not bring one back that exited -- a crash, a
# network drop the listener gave up on, a self-update that failed halfway, or an operator's "svc.sh stop" all
# leave a runner down until somebody notices. This is the same gap the Windows runner's repeating trigger
# closes, and the same answer: ask every few minutes, start what is not active.
`$down = @()
foreach (`$unit in `$Units) {
    `$state = (& wsl.exe -d `$Distro -e systemctl is-active `$unit 2>`$null | ForEach-Object { (`$_ -replace "``0", '').Trim() }) -join ''
    if (`$state -ne 'active') { `$down += `$unit }
}
if (`$down.Count -gt 0) {
    Say "starting `$(`$down.Count) runner unit(s): `$(`$down -join ', ')"
    foreach (`$unit in `$down) { & wsl.exe -d `$Distro -u root -e systemctl start `$unit 2>&1 | Out-Null }
}

# -- 5. what this pass found -------------------------------------------------------------------------------------
`$active = 0
foreach (`$unit in `$Units) {
    `$state = (& wsl.exe -d `$Distro -e systemctl is-active `$unit 2>`$null | ForEach-Object { (`$_ -replace "``0", '').Trim() }) -join ''
    if (`$state -eq 'active') { `$active++ }
}
Say "pass: `$active/`$(`$Units.Count) runners active`$(if (`$down.Count) { " (started `$(`$down.Count))" })"

# Bounded, because this file is appended to every few minutes for the life of the machine. FOUR thousand lines,
# not two: a pass now writes the disk line as well as the summary, and the window that matters is "several days"
# rather than a line count -- it is the window in which anybody asks what happened.
try {
    `$lines = @(Get-Content '$LogPath' -ErrorAction Stop)
    if (`$lines.Count -gt 4000) { Set-Content -Path '$LogPath' -Value (`$lines | Select-Object -Last 2000) }
} catch { }
"@

if ($Check) {
    Step 'check only -- nothing was registered or changed.'
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Step "the '$TaskName' task is registered." } else { Warn "the '$TaskName' task is NOT registered -- nothing starts this fleet after a reboot." }
    exit 0
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
Set-Content -Path $Reconciler -Value $reconcilerBody -Encoding UTF8
Step "wrote the reconciler to $Reconciler"

# -- Docker Desktop's own start-at-logon ------------------------------------------------------------------------
# Belt as well as braces, and it buys the ordering rather than just the uptime: with AutoStart on, the engine is
# already coming up when the first watchdog pass runs, so the distro is not started into a VM that Docker
# Desktop is about to restart underneath it. The watchdog covers the case where this setting is ignored or the
# app has crashed.
if (-not $NoDockerAutoStart -and (Test-Path $DockerSettings)) {
    try {
        $settings = Get-Content $DockerSettings -Raw | ConvertFrom-Json
        if (-not $settings.AutoStart) {
            $settings.AutoStart = $true
            ($settings | ConvertTo-Json -Depth 10) | Set-Content -Path $DockerSettings -Encoding UTF8
            Step 'turned on Docker Desktop AutoStart, so the engine is up before the fleet is.'
        } else {
            Step 'Docker Desktop AutoStart is already on.'
        }
    } catch {
        Warn "could not read or write $DockerSettings ($($_.Exception.Message)) -- the watchdog still starts Docker Desktop, it just starts it a few minutes later than logon."
    }
}

# -- the VM's idle shutdown, which is the deeper half of this -----------------------------------------------------
# `vmIdleTimeout` DEFAULTS TO 60000 MILLISECONDS, and the WSL documentation says exactly what that means: "the
# number of milliseconds that a VM is idle, before it is shut down". So on a stock host the fleet's uptime was
# never a property of the machine at all -- the VM powers itself off a minute after the last `wsl.exe` client
# goes away, taking systemd and all six listeners with it, and GitHub shows six runners going offline for a
# reason that is in neither the runner's log nor the journal, because from inside the distro nothing went wrong.
#
# Measured here: every unit stopping at the same second, then coming back the moment anything ran `wsl.exe`
# again. It is what makes "the fleet is up" a statement about whether somebody happens to have a shell open.
#
# The watchdog alone would paper over this at a cost that is not worth paying: a three-minute reconcile against
# a sixty-second timeout leaves the fleet down most of the time. This is the setting that removes the cause.
#
# TAKES EFFECT AT THE NEXT VM START, not now: WSL reads .wslconfig when the VM boots. -Restart is the switch
# that does that here, and the block below is why it is a switch rather than a default.
if (-not $NoIdleTimeout) {
    $lines = if (Test-Path $WslConfig) { @(Get-Content $WslConfig) } else { @() }
    # Hand-parsed rather than round-tripped through some INI library: this file is the operator's, it holds
    # their memory, swap and networking settings, and the change wanted here is one key in one section.
    $inWsl2 = $false; $done = $false; $updated = @()
    foreach ($line in $lines) {
        if ($line -match '^\s*\[(.+)\]\s*$') {
            # Leaving the section: if the key was never seen inside it, add it before moving on.
            if ($inWsl2 -and -not $done) { $updated += 'vmIdleTimeout=-1'; $done = $true }
            $inWsl2 = $matches[1] -eq 'wsl2'
        } elseif ($inWsl2 -and $line -match '^\s*vmIdleTimeout\s*=') {
            $line = 'vmIdleTimeout=-1'; $done = $true
        }
        $updated += $line
    }
    if ($inWsl2 -and -not $done) { $updated += 'vmIdleTimeout=-1'; $done = $true }
    if (-not $done) { $updated += @('[wsl2]', 'vmIdleTimeout=-1') }

    if (($lines -join "`n") -ne ($updated -join "`n")) {
        Set-Content -Path $WslConfig -Value $updated -Encoding UTF8
        Step "set vmIdleTimeout=-1 in $WslConfig -- the WSL VM no longer powers itself off when the fleet goes quiet."
        $idleTimeoutChanged = $true
    } else {
        Step 'vmIdleTimeout is already -1.'
    }
}

# -- the task ---------------------------------------------------------------------------------------------------
if ($LauncherPath) {
    # --wait, so the task is 'running' for exactly as long as the pass takes and IgnoreNew means what it says.
    $action = New-ScheduledTaskAction -Execute $LauncherPath `
        -Argument "--log `"$LaunchLog`" --wait -- powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Reconciler`"" `
        -WorkingDirectory $Root
} else {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Reconciler`"" `
        -WorkingDirectory $Root
}

# TWO TRIGGERS, and the second is the one that makes this unattended. At logon for the reboot -- the case this
# machine actually hit. Then a repetition for every other way the fleet goes down without anybody logging out:
# `wsl --shutdown` from a Docker Desktop update, a listener that exited, a distro somebody stopped.
#
# NO -RepetitionDuration, and that is the spelling of "forever": an empty duration is how the Task Scheduler
# schema says indefinite, and omitting the parameter is what produces it. [TimeSpan]::MaxValue looks like the
# documented answer, inspects perfectly, and is then refused by Register-ScheduledTask as out of range.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes)

# A FINITE ExecutionTimeLimit, unlike the Windows runner's task, and the difference is what the action IS. That
# one hosts a listener and is meant to live forever, so a limit would kill the runner. This one is a pass that
# should take seconds: if it ever hangs -- on a `wsl.exe` that never returns, on an engine that never answers --
# IgnoreNew would swallow every repetition behind it and the supervision would stop silently. The limit is what
# guarantees the next pass gets to run.
$settingsSet = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# -ErrorAction Stop on this one call, against the file-wide 'Continue'. That preference is for the probes above,
# where a non-zero exit is the answer being sought. A registration is not a probe: it either happened or this
# script has nothing to report.
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atLogon, $watchdog) `
        -Settings $settingsSet -Force -ErrorAction Stop | Out-Null
} catch {
    Die "could not register the '$TaskName' task, so this machine is unchanged: $($_.Exception.Message)"
}

# -- restarting the VM, which is the only way a new .wslconfig is read ---------------------------------------------
if ($Restart) {
    # ASKED BEFORE THE VM GOES DOWN. `Runner.Worker` is the per-job process a listener spawns, so its presence
    # IS "a job is executing" -- and taking the VM out from under one shows up on the Actions page as a step
    # dying after every assertion in it passed, with nothing in the log naming a cause. The same trap
    # setup-windows-runner.ps1 documents, reached from the other side.
    $working = @(& wsl.exe -d $Distro -e pgrep -c Runner.Worker 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ -match '^\d+$' })
    $busy = if ($working) { [int]$working[0] } else { 0 }
    if ($busy -gt 0 -and -not $Force) {
        Die "$busy job(s) are executing on this fleet right now. Restarting the WSL VM would fail them at whatever step they had reached, and the failure would name the step rather than this command. Wait, or re-run with -Force. Everything else is already in place; only the .wslconfig change is waiting on a restart."
    }
    if ($busy -gt 0) { Step "$busy job(s) are in flight and -Force was given: they will fail, and be retried against the runners that come back." }
    # DOCKER DESKTOP GOES DOWN FIRST, AND THAT IS NOT TIDINESS. `wsl --shutdown` takes its `docker-desktop`
    # distro out from under it; its Windows processes stay up and its engine answers 500 to everything from
    # then on, with no self-healing. Stopping it here means the reconciler's pass below finds no Docker Desktop
    # at all and takes the fast path -- start it, wait for the engine -- instead of spending 90 seconds
    # discovering that the one still on screen is dead.
    Step 'stopping Docker Desktop and restarting the WSL VM so the new .wslconfig is read...'
    Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build', 'com.docker.dev-envs', 'com.docker.extensions' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 8
    & wsl.exe --shutdown
    Start-Sleep -Seconds 10
} elseif ($idleTimeoutChanged) {
    Warn 'vmIdleTimeout was just written and WSL reads .wslconfig only when the VM starts, so the fleet is STILL on the 60-second idle shutdown until the next restart. Re-run with -Restart when no job is executing.'
}

Step 'running one pass now...'
Start-ScheduledTask -TaskName $TaskName
# WAITS ON THE PROPERTY, NOT ON A CLOCK. A pass that has to start Docker Desktop and wait for its engine takes
# minutes, not seconds, and a fixed sleep short enough to be pleasant is one that reports a working fix as a
# broken one. `-l --running -q` is the probe because it is the only one here that does NOT start the distro:
# asking systemd anything would start it and make this check about itself.
$deadline = (Get-Date).AddMinutes(8)
while ((Get-Date) -lt $deadline) {
    $up = @(& wsl.exe -l --running -q 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
    if ($up -contains $Distro) { break }
    Start-Sleep -Seconds 10
}

# -- verify the properties that matter --------------------------------------------------------------------------
# Read back rather than trust that asking for a shape produced it. A fleet that is up right now is not evidence
# of this script's work -- it was up before the script ran, which is exactly how a failed registration would
# report success.
$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $registered) { Die "the '$TaskName' task is not registered, so nothing brings this fleet back." }
$repetition = ($registered.Triggers | Where-Object { $_.Repetition.Interval } | Select-Object -First 1).Repetition.Interval
if (-not $repetition) { Die 'the task carries no repeating trigger, so it would only ever fix the fleet at logon. The registration did not take.' }
if (-not ($registered.Triggers | Where-Object { "$($_.CimClass.CimClassName)$($_.pstypenames)" -match 'Logon' })) {
    Die 'the task carries no logon trigger, which is the reboot case this exists for. The registration did not take.'
}

$running = @(& wsl.exe -l --running -q 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
if ($running -notcontains $Distro) { Die "$Distro is still not running after a pass. Read $LogPath." }
$inactive = @()
foreach ($unit in $units) {
    $state = (& wsl.exe -d $Distro -e systemctl is-active $unit 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() }) -join ''
    if ($state -ne 'active') { $inactive += "$unit ($state)" }
}
if ($inactive) { Die "these runner units are not active after a pass: $($inactive -join ', '). Read $LogPath and the unit's journal in $Distro." }

Write-Host ''
Step "ready: $Distro is up with $($units.Count) runner units active."
Step "it is reconciled at every sign-in and every $WatchdogMinutes minutes ($repetition, read back off the registered task) -- nothing to keep open, nothing to babysit."
Step "every probe is bounded ($EngineProbeSeconds s for the engine), so a wedged docker can no longer park a pass and take the supervision down with it."
Step "free space on this host is read and logged every pass, and rebuildable docker state is reclaimed under $LowDiskGb GB. Nothing tagged and no volume is ever pruned -- this daemon also runs your sandboxes."
Step "the pass logs to $LogPath."
if (-not $LauncherPath) { Warn 'without the launcher stub this task maps a console window for a moment on every pass, on the machine whose desktop tiers read window titles. See -LauncherPath.' }
Step 'after an unattended reboot this still waits for a sign-in. Windows signs itself back in after its own update restarts; for anything else, see -AutoLogon in setup-windows-runner.ps1.'
