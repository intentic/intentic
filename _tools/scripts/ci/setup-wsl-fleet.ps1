<#
.SYNOPSIS
  Make the Linux CI fleet come back on its own. Companion to docs/ops/ci-runner.md, which describes the six runner
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
  to answer before it touches the distro, every time, for both reasons. Necessary and not sufficient: an engine
  that answers on WINDOWS is not a `docker` the runners can reach, which is the fifth way below.

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

  AND THE FIFTH WAY WAS THE PROBE THIS FILE DID NOT HAVE. Every docker question above is asked on WINDOWS, and
  Windows is not where the jobs run: `docker.exe version` answering says the engine is alive and says nothing
  about whether the six runner processes, inside the distro, can find a `docker` to talk to it with. That binary
  and the socket beside it are Docker Desktop's WSL integration, present exactly while it is applied to this
  distro. On 7 September the engine answered on Windows all day, every pass logged a healthy machine, and three
  pipelines failed in FIVE SECONDS each -- both DAG roots dying in "Set up job" on `docker: command not found`,
  eighteen jobs skipped behind them, four of the six workers, five and a half hours, no failed assertion
  anywhere. The pass now asks the question the runner asks: a non-login `sh` in the distro, because these are
  systemd services and a login shell's PATH is not theirs. The repair costs nothing -- the integration's CLI and
  the engine's socket sit under /mnt/wsl, the utility VM's shared mount, which every distro in that VM can see
  whether or not Docker Desktop was told to integrate with it, so a symlink into /usr/local/bin restores what a
  dropped integration took away, with nothing restarted and no job lost.

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
    # The least time between two passes restarting Docker Desktop to re-apply a WSL integration that left the
    # distro without /var/run/docker.sock. One restart heals the case this exists for; an integration that
    # stays broken after it needs a person, not a restart every three minutes.
    [int]$IntegrationRestartMinutes = 10,
    # How long a job waits, in its job-started hook, for docker to answer inside the distro before it fails.
    # Longer than a watchdog pass plus the integration restart it may make, so the job outlives the repair.
    [int]$DockerWaitSeconds = 600,
    # Free space on the host volume, in GB, under which a pass reclaims rebuildable docker state. Twice this is
    # only reported; half of it takes the whole build cache rather than the stale part.
    [int]$LowDiskGb = 60,
    # The lock a WSL maintenance run holds for its whole length, compaction included: wsl-maintenance.ps1 writes
    # its pid here before it starts and removes the file when it ends. While it is held a pass does nothing, so
    # it neither boots the distro nor restarts Docker Desktop under a disk being compacted. Empty turns it off.
    [string]$MaintenanceLock = 'C:\ProgramData\wsl-maintenance\.lock',
    # How old a held lock may be before a pass stops honouring it. The same three hours the maintenance script
    # gives its own lock, and its scheduled tasks' ExecutionTimeLimit: a run older than that has been killed.
    [int]$MaintenanceLockHours = 3,
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
# When a pass last restarted Docker Desktop to re-apply the WSL integration. A file for the same reason as the
# one above: the "not again within N minutes" it enforces spans passes.
$IntegrationRestartStamp = Join-Path $Root 'integration-restarted-at.txt'
# The job-started hook, inside the distro. Every runner's .env points ACTIONS_RUNNER_HOOK_JOB_STARTED here.
$HookPath = '/usr/local/lib/intentic-ci/wait-for-docker.sh'
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
# The unit count is read off the distro, never taken from docs/ops/ci-runner.md; this also starts the distro.
Step "asking $Distro which runner units it carries..."
$unitList = & wsl.exe -d $Distro -e systemctl list-unit-files $UnitPattern --no-pager --plain --no-legend 2>$null
$units = @($unitList | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ } |
    ForEach-Object { ($_ -split '\s+')[0] })
if (-not $units) {
    Die "no units matching '$UnitPattern' in $Distro. Register the runners first -- docs/ops/ci-runner.md has the config.sh and svc.sh commands -- then run this."
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

# -- the job-started hook: a job waits for docker instead of failing on it ---------------------------------------
# The watchdog repairs a missing /var/run/docker.sock within a pass or two, and a job that lands in that window
# used to die in 30 seconds in Initialize containers on "failed to connect to the docker API" -- twice on 26
# September. ACTIONS_RUNNER_HOOK_JOB_STARTED runs before the job's containers are created, so a hook that waits
# for the daemon turns those into jobs that start a few minutes late. It fails the job itself only after
# $DockerWaitSeconds seconds, with a line naming the machine, which is a real outage and should be red.
#
# THE MARKER is what lets the watchdog tell this wait from a working job: a Runner.Worker is running either way,
# and the integration restart may only happen while no job is working. Named after the hook's pid, so the
# watchdog counts only markers whose process is still alive.
#
# Installed by this script rather than by hand because a runner re-registered with config.sh keeps its .env,
# and a new one gets the line on the next run of this script -- the documented last step of registering one.
$hookBody = @'
#!/bin/sh
# GENERATED by _tools/scripts/ci/setup-wsl-fleet.ps1 -- ACTIONS_RUNNER_HOOK_JOB_STARTED for the WSL fleet.
# Waits for docker to answer through /var/run/docker.sock before the job's containers are created.
limit=__LIMIT__
marker=/tmp/intentic-docker-wait.$$
trap 'rm -f "$marker"' EXIT
trap 'exit 143' TERM INT
waited=0
while ! timeout 15 docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
    if [ "$waited" -ge "$limit" ]; then
        # printf, not echo: a dash echo reads the backslashes in the Windows path below as escapes, and \c ends it.
        printf '%s\n' "::error::no docker daemon answered through /var/run/docker.sock on $(uname -n) for ${limit}s: Docker Desktop's WSL integration is not applied there. The Intentic CI Fleet task's log (%LOCALAPPDATA%\intentic\ci-fleet\fleet.log) says what it tried."
        exit 1
    fi
    if [ "$waited" -eq 0 ]; then
        echo "docker is not answering on this runner; waiting up to ${limit}s for the fleet watchdog to re-apply Docker Desktop's WSL integration"
        : > "$marker"
    fi
    sleep 10
    waited=$((waited + 10))
done
if [ "$waited" -gt 0 ]; then echo "docker answered after ${waited}s"; fi
exit 0
'@
$hookBody = $hookBody.Replace('__LIMIT__', "$DockerWaitSeconds")

# Each unit's own directory and user, read off systemd: svc.sh writes both into the unit.
function UnitProperty($unit, $name) {
    return ((& wsl.exe -d $Distro -e systemctl show -p $name --value $unit 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() }) -join '')
}
$hookLine = "ACTIONS_RUNNER_HOOK_JOB_STARTED=$HookPath"
$hookChanged = @()
if ($Check) {
    $missing = @()
    foreach ($unit in $units) {
        $dir = UnitProperty $unit 'WorkingDirectory'
        & wsl.exe -d $Distro -e /bin/sh -c "grep -qx '$hookLine' '$dir/.env' 2>/dev/null && test -x '$HookPath'" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { $missing += $unit }
    }
    if ($missing) { Warn "$($missing.Count) runner(s) have no job-started hook, so a job that lands while docker is missing in $Distro fails in 30 seconds instead of waiting: $($missing -join ', '). Re-run without -Check." }
    else { Step "every runner waits for docker in its job-started hook ($HookPath)." }
} else {
    # CR stripped inside the distro too: a pipe from PowerShell ends every line with CRLF, and a shell script
    # with a CR on its shebang line does not run at all.
    ($hookBody -replace "`r", '') | & wsl.exe -d $Distro -u root -e /bin/sh -c "mkdir -p $($HookPath.Substring(0, $HookPath.LastIndexOf('/'))) && tr -d '\r' > $HookPath && chmod 755 $HookPath"
    if ($LASTEXITCODE -ne 0) { Warn "could not write the job-started hook to $HookPath in $Distro -- jobs keep failing fast while docker is missing there." }
    foreach ($unit in $units) {
        $dir = UnitProperty $unit 'WorkingDirectory'
        $user = UnitProperty $unit 'User'
        if (-not $dir) { Warn "could not read $unit's directory from systemd -- its .env is left alone."; continue }
        # As the runner's own user, so .env keeps its owner. sed rather than an append, so a changed path
        # replaces the old line instead of stacking a second one the runner would read last.
        $userArgs = if ($user) { @('-u', $user) } else { @() }
        $out = (& wsl.exe -d $Distro @userArgs -e /bin/sh -c "cd '$dir' && touch .env && if grep -qx '$hookLine' .env; then echo same; else sed -i '/^ACTIONS_RUNNER_HOOK_JOB_STARTED=/d' .env && echo '$hookLine' >> .env && echo changed; fi" 2>$null |
            ForEach-Object { ($_ -replace "`0", '').Trim() }) -join ''
        if ($out -eq 'changed') { $hookChanged += @{ Unit = $unit; Dir = $dir } }
        elseif ($out -ne 'same') { Warn "could not add the job-started hook to $dir/.env -- that runner keeps failing fast while docker is missing." }
    }
    if ($hookChanged) { Step "added the job-started hook to $($hookChanged.Count) runner .env file(s); each is restarted below once it is idle, because a listener reads .env only when it starts." }
    else { Step 'every runner already carries the job-started hook.' }
}

# -- the windowless launcher ----------------------------------------------------------------------------------
# The reconciler runs every $WatchdogMinutes for the life of this machine, and this host is also the one whose
# desktop tiers assert on window titles: a console window appearing on it every three minutes is a flake
# generator, not a cosmetic problem.
#
# `powershell -WindowStyle Hidden` DOES NOT HOLD on a current Windows 11, and _devices/win-launcher/README.md
# says why: with Windows Terminal as the default console host, the hidden flag hides the console the
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
        # Where the device agent installs it, which is the only copy on a CI host that runs no intentic host.
        (Join-Path $env:USERPROFILE '.intentic\machine\bin\intentic-launch.exe'),
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
# A guard added here is inert on a host until this script is re-run THERE, so the generation date is carried
# into the reconciler and `-Check` diffs it against what this file would write now.
$GeneratedAt = Get-Date -Format 'yyyy-MM-dd'
$reconcilerBody = @"
# GENERATED by _tools/scripts/ci/setup-wsl-fleet.ps1 -- edit that file and re-run it, not this one.
#
# One pass of "is the Linux CI fleet the way it should be". Run at logon and every few minutes by the
# '$TaskName' scheduled task. Probes first and acts only on what is wrong, so the healthy pass is a few seconds
# and changes nothing.
#
# The date this pass was generated. A host running a reconciler older than the guard being looked for is
# otherwise indistinguishable from one that has it, so this rides in every pass line.
`$GeneratedOn = '$GeneratedAt'
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

# -- 0b. a WSL maintenance run in progress -----------------------------------------------------------------------
# NOTHING BELOW MAY RUN UNDER A DISK COMPACTION. The host's maintenance task (C:\ProgramData\wsl-maintenance)
# stops Docker Desktop, runs ``wsl --shutdown`` and then compacts every VHDX with diskpart, which needs each file
# closed. Every pass boots the distro (section 3, and each ``wsl.exe -d`` probe does the same) and may run
# ``docker desktop restart`` (section 3b), so a pass landing in that window holds ext4.vhdx open and the compaction
# fails "because it is being used by another process" -- how archlinux's disk kept failing to shrink on 26 and 27
# September -- or hands Docker Desktop a distro still booting, the "setup groups" failure section 3b exists for.
# The maintenance run boots the distros and re-applies the integration itself when it is done.
#
# HONOURED WHILE IT IS FRESH AND ITS WRITER IS ALIVE. The file holds the writer's pid. A lock older than
# $MaintenanceLockHours h, or whose pid is no PowerShell any more, is a run that was killed before it could clean up:
# it is logged and ignored, since a dead lock honoured for ever would be the fleet down with nothing reporting it.
`$maintenanceLock = if ('$MaintenanceLock') { Get-Item -LiteralPath '$MaintenanceLock' -Force -ErrorAction SilentlyContinue }
if (`$maintenanceLock) {
    `$lockAge = (Get-Date) - `$maintenanceLock.LastWriteTime
    `$lockPid = (Get-Content -LiteralPath `$maintenanceLock.FullName -TotalCount 1 -ErrorAction SilentlyContinue) -as [int]
    `$lockWriter = if (`$lockPid) { Get-Process -Id `$lockPid -ErrorAction SilentlyContinue }
    `$writerGone = `$lockPid -and -not (`$lockWriter -and `$lockWriter.ProcessName -match '^(powershell|pwsh)`$')
    `$since = `$maintenanceLock.LastWriteTime.ToString('HH:mm')
    `$holder = if (`$lockPid) { "pid `$lockPid, " } else { '' }
    if (`$lockAge.TotalHours -lt $MaintenanceLockHours -and -not `$writerGone) {
        Say "maintenance: a WSL maintenance run holds `$(`$maintenanceLock.FullName) (`${holder}since `$since) and may be compacting the distro disks -- skipping this pass rather than booting `$Distro or restarting Docker Desktop under it"
        exit 0
    }
    `$why = if (`$writerGone) { "pid `$lockPid is no PowerShell any more" } else { "older than $MaintenanceLockHours h" }
    Say "maintenance: ignoring the stale lock `$(`$maintenanceLock.FullName) from `$since (`$why) -- a run that was killed before it could remove it"
}

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
# second, "unexpected EOF" in one and exit 255 in the other, with every step after them reporting "Cannot
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
# machine -- docs/ops/ci-runner.md's "Keeping it bounded" covered turbo, pnpm, cargo, xwin and playwright, and not
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
        # THE IMAGE STORE IS ONLY REBUILDABLE WHEN NOTHING IS WRITING TO IT, and this section treated it as
        # rebuildable unconditionally. `image prune` takes every DANGLING image, and a `docker pull` in flight
        # is producing exactly that: layers unpacked and not yet tagged, each the parent the next one extracts
        # onto. Reclaimed mid-pull, the extraction is left with no parent and the pull dies with every byte
        # already downloaded -- "parent snapshot sha256:ceeb23b4 does not exist: not found", which is how
        # release 1.285.0 lost its amd64 smoke gate while this reconciler was taking its three-minute pass over
        # the same daemon. smoke-image.sh now survives one (image-pull.sh); not causing it is this end's half.
        #
        # SKIPPED WHILE THE FLEET IS WORKING, NOT DEFERRED FOREVER, the same shape as the engine restart above:
        # the next pass three minutes later still finds the host under the floor, and a host DEEP under it
        # prunes anyway -- an engine wedged on a disk with nothing left fails every job on this machine, which
        # is worse than one pull that has to be pulled again. The build caches are BuildKit's own and rebuilt
        # on demand by the next build, so they stay in scope either way, and on this host they are the bulk.
        `$busyNow = BusyRunners
        `$skipImages = (`$busyNow -gt 0) -and (-not `$deep)
        if (`$skipImages) {
            Say "disk: `$busyNow job(s) are executing -- reclaiming build cache only and leaving the image store alone: pruning dangling images out from under a running pull is how a release loses the parent snapshot it is extracting onto"
        }
        # A BUDGET, because the pass runs under a 15-minute ExecutionTimeLimit and a prune on a full disk is
        # slow. Whatever does not fit is not lost -- the next pass three minutes later still sees a host under
        # the floor and picks up where this one stopped.
        `$pruneDeadline = (Get-Date).AddMinutes(5)
        foreach (`$cmd in @("buildx prune --builder intentic-cache `$cacheArgs", "builder prune `$cacheArgs", 'image prune -f')) {
            if (`$cmd -eq 'image prune -f' -and `$skipImages) { continue }
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

# -- 3b. the docker CLI INSIDE the distro, which is what a job actually reaches for -------------------------------
# EVERY PROBE ABOVE THIS ONE ASKED WINDOWS, and Windows is not where the jobs run. docker.exe answering on the
# host proves the engine is alive; it says nothing about whether the six runner processes -- Linux processes,
# inside this distro -- can find a docker to talk to it with. That binary is not the distro's own: Docker
# Desktop injects it, and the socket beside it, through its WSL INTEGRATION, so both are present exactly while
# that integration is applied to THIS distro and gone the moment it is not -- after its docker-desktop distro is
# terminated, after an update or a reset drops this distro from the integration list, or on a fleet started into
# a VM where the integration was never re-established.
#
# WHAT THAT COSTS, and it is the whole reason this section exists: on 7 September the engine answered on Windows
# all day, every pass logged a healthy machine, and every job the fleet took died in FIVE SECONDS in Set up job
# on
#
#     ##[error]docker: command not found
#
# Three pipelines went that way -- runs 34108789062, 34116132200 and 34138843648, across four of the six workers
# -- and each took eighteen skipped jobs down with its two failed DAG roots, because both roots run in a
# container. The runner resolves docker off its own PATH BEFORE it creates that container, so this is not a step
# failing: it is the job never starting, with no failed assertion anywhere and nothing on the machine reporting
# a fault. Ordering the engine ahead of the fleet (section 1) does not cover it: the engine was up.
#
# THE PROBE RUNS IN A NON-LOGIN SHELL, deliberately. The runners are systemd services, so nothing sources
# /etc/profile.d for them: a docker that exists only on an interactive PATH is a docker the fleet cannot use,
# and sh -lc would read that machine as healthy. The repair links into /usr/local/bin for the same reason -- on
# the service's PATH, not on a profile's.
#
# AND THE REPAIR NEEDS NOTHING RESTARTED, which is what makes it safe to run every pass. The integration's
# binaries and the engine's socket live under /mnt/wsl, the shared mount of the utility VM, which EVERY distro
# in that VM can see whether or not Docker Desktop has been told to integrate with it. So a symlink is the whole
# fix for the case where they are there and this distro's PATH is not, and it cannot take the VM out from under
# a running job the way section 1's last resort can.
function DistroSh(`$script) { return RunBounded 'wsl.exe' "-d `$Distro -e /bin/sh -c ""`$script""" $EngineProbeSeconds }
function DistroShRoot(`$script) { return RunBounded 'wsl.exe' "-d `$Distro -u root -e /bin/sh -c ""`$script""" $EngineProbeSeconds }
# STDERR IS REDIRECTED AND NEVER READ (see RunBounded), so a command noisy on it fills a pipe nobody drains and
# the probe TIMES OUT instead of answering. Both searches below therefore run as root and discard stderr:
# /mnt/wsl carries directories the fleet's own user cannot enter.
function DistroLines(`$result) {
    if (`$null -eq `$result) { return @() }
    return @((`$result.Out -replace "``0", '') -split "``n" | ForEach-Object { `$_.Trim() } | Where-Object { `$_ })
}

# CLIENT ONLY. docker --version talks to no daemon, so it separates "the fleet cannot find docker" from "docker
# is there and the engine is down" -- which section 1 has already reported, and which this section must not
# report a second time as a fault of its own.
`$cli = DistroSh 'docker --version'
`$cliAnswered = `$null -ne `$cli
`$cliOk = `$cliAnswered -and `$cli.Code -eq 0
if (`$cliAnswered -and -not `$cliOk) {
    `$found = @(DistroLines (DistroShRoot 'find /mnt/wsl -maxdepth 6 -type f -name docker -perm -u+x 2>/dev/null')) |
        Select-Object -First 1
    if (`$found) {
        Say "the fleet's PATH in `$Distro has no docker, but the integration's copy is at `$found -- linking it into /usr/local/bin"
        DistroShRoot "ln -sfn `$found /usr/local/bin/docker" | Out-Null
        `$cli = DistroSh 'docker --version'
        `$cliOk = (`$null -ne `$cli -and `$cli.Code -eq 0)
    }
}

# THE SOCKET IS THE OTHER HALF, and it is the half that does not survive a boot: /var/run is a tmpfs, so the
# socket the integration puts there is gone on every distro start and re-made only by an integration that is
# applied. Re-checked every pass for that reason. A CLI that runs with no socket under it is "failed to connect
# to the docker API at unix:///var/run/docker.sock" in Initialize containers -- a different line in the log and
# the same dead pipeline.
#
# ASKED AS THE FLEET'S OWN USER, AND ANSWERED BY THE DAEMON, not by "test -S". A socket that exists and that
# user cannot connect to is the same dead pipeline with a healthy-looking probe.
#
# THE REPAIR IS DOCKER DESKTOP'S OWN, NOT A SYMLINK. This section used to link a docker.sock found under /mnt/wsl
# into /var/run. Docker Desktop 4.91 has no file of that name there: the engine sits behind
# guest-services/docker.proxy.sock, root:root 0755, so a link to it is a socket the runners' user cannot
# connect to, placed where the integration writes its own. What works is re-applying the integration.
#
# WHY IT NEEDS DOING AT ALL, measured on 27 September: a Docker Desktop restart applied the integration to a
# distro that had just booted, `wsl.exe -d archlinux -e whoami` timed out (Wsl/Service/0x8007274c), the agent
# exited on "setup groups", and Docker Desktop raised a dialog offering "Restart the WSL integration" and waited
# on it. It does not retry. The engine answered on Windows throughout, so section 1 saw a healthy machine and
# every pass logged 6/6 runners active through a two-and-a-half-hour outage. `docker desktop restart`
# re-applied it in 16 seconds, and the distro and its runners stayed up.
#
# ONLY WHILE NO JOB IS WORKING, the rule every restart in this file keeps. A job parked in the job-started hook
# this script installs waiting for this very socket is not working, so it is not counted: counting it would have the
# hook and this pass wait on each other until the hook gives up. And AT MOST ONCE PER $IntegrationRestartMinutes
# MINUTES, stamped in a file because every pass is a new process, so an integration that will not come back
# gets a person's attention rather than a restart every three minutes forever.
function FleetDockerAnswers {
    `$r = DistroSh 'test -S /var/run/docker.sock && docker version --format {{.Server.Version}}'
    if (`$null -eq `$r) { return `$null }
    return (`$r.Code -eq 0)
}
# Runner.Worker processes minus the ones whose job is waiting in the hook. The hook drops a marker named after
# its own pid and the pid is checked, so a hook killed mid-wait leaves nothing that counts.
function WorkingRunners {
    `$r = RunBounded 'wsl.exe' '-d $Distro -e /bin/sh -c "w=`$(pgrep -c -x Runner.Worker); n=0; for f in /tmp/intentic-docker-wait.*; do p=`${f##*.}; kill -0 `$p 2>/dev/null && n=`$((n+1)); done; echo `$((w-n))"' $EngineProbeSeconds
    if (`$null -eq `$r) { return 0 }
    `$n = (`$r.Out -replace "``0", '').Trim()
    if (`$n -match '^\d+`$') { return [int]`$n }
    return 0
}
`$sockOk = FleetDockerAnswers
if (`$sockOk -eq `$false -and `$cliOk -and (EngineReady)) {
    # A Docker Desktop that section 1 has just started applies the integration a few seconds after its engine
    # answers, so a missing socket gets a minute before it counts as missing.
    `$graceEnd = (Get-Date).AddSeconds(60)
    while (`$sockOk -eq `$false -and (Get-Date) -lt `$graceEnd) { Start-Sleep -Seconds 10; `$sockOk = FleetDockerAnswers }
}
if (`$sockOk -eq `$false -and `$cliOk -and (EngineReady)) {
    `$lastRestart = `$null
    try {
        `$stamp = (Get-Content '$IntegrationRestartStamp' -ErrorAction Stop | Select-Object -First 1)
        `$lastRestart = [datetime]::Parse(`$stamp, [Globalization.CultureInfo]::InvariantCulture)
    } catch { }
    `$working = WorkingRunners
    if (`$working -gt 0) {
        Say "docker in `${Distro}: no daemon answers through /var/run/docker.sock while the engine answers on Windows, so Docker Desktop's WSL integration is not applied -- `$working job(s) are working, so NOT restarting Docker Desktop this pass"
    } elseif (`$lastRestart -and ((Get-Date) - `$lastRestart).TotalMinutes -lt $IntegrationRestartMinutes) {
        Say "docker in `${Distro}: the WSL integration is still not applied after the restart at `$(`$lastRestart.ToString('HH:mm')) -- not restarting again within $IntegrationRestartMinutes min. Open Docker Desktop: its error dialog offers 'Restart the WSL integration'"
    } else {
        Say "docker in `${Distro}: no daemon answers through /var/run/docker.sock while the engine answers on Windows, so Docker Desktop's WSL integration is not applied -- no job is working, re-applying it with 'docker desktop restart'"
        Set-Content -Path '$IntegrationRestartStamp' -Value (Get-Date).ToString('o') -ErrorAction SilentlyContinue
        RunBounded `$dockerExe 'desktop restart' 180 | Out-Null
        `$deadline = (Get-Date).AddSeconds(120)
        do { Start-Sleep -Seconds 10; `$sockOk = FleetDockerAnswers } while (`$sockOk -ne `$true -and (Get-Date) -lt `$deadline)
        if (`$sockOk) { Say "docker in `${Distro}: the WSL integration is applied again after the restart" }
    }
}
`$sockAnswered = `$null -ne `$sockOk

# ONE LINE EVERY PASS, healthy or not, for the same reason the disk gets one: this is the state a person reads
# the log to find, and the pass that says nothing is the pass that made a five-hour outage look like a quiet
# machine.
if (-not `$cliAnswered -or -not `$sockAnswered) {
    Say "docker in `${Distro}: the probe TIMED OUT, so whether this fleet can run a container job is UNKNOWN -- the distro is not answering, which is not the same as a healthy one"
} elseif (`$cliOk -and `$sockOk) {
    `$server = @(DistroLines (DistroSh 'docker version --format {{.Server.Version}}')) | Select-Object -First 1
    Say "docker in `${Distro}: server `$server -- a container job can start here"
} elseif (`$cliOk) {
    Say "docker in `${Distro}: the CLI runs but no daemon answers through /var/run/docker.sock as the fleet's own user. EVERY container job this fleet takes will fail in Initialize containers until it does. If the engine answers on Windows this is Docker Desktop's WSL integration (the lines above say what this pass tried); if it does not, it is the engine (section 1)."
} else {
    # THE FLEET IS STARTED ANYWAY, below, and its jobs will fail. That is deliberate and it is the same choice
    # section 1 makes: a red pipeline names the machine and this file's oldest lesson is that a queue against a
    # label nothing answers went unnoticed for three and a half days. Stopping the listeners would trade a
    # failure that reports itself for a silence that does not.
    Say "docker in `$Distro is NOT USABLE BY THE FLEET (no docker CLI on its PATH) and nothing under /mnt/wsl could be linked in its place, so Docker Desktop's WSL integration is not applied to this machine at all. EVERY container job this fleet takes will fail in Set up job on 'docker: command not found'. Switch the integration on for `$Distro under Docker Desktop, Settings, Resources, WSL integration: a -Restart re-applies an integration that is enabled and merely absent, and cannot turn on one that is off."
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
Say "pass: `$active/`$(`$Units.Count) runners active`$(if (`$down.Count) { " (started `$(`$down.Count))" }) [gen `$GeneratedOn]"

# Bounded, because this file is appended to every few minutes for the life of the machine. FOUR thousand lines,
# not two: a pass now writes the disk line as well as the summary, and the window that matters is "several days"
# rather than a line count -- it is the window in which anybody asks what happened.
try {
    `$lines = @(Get-Content '$LogPath' -ErrorAction Stop)
    if (`$lines.Count -gt 4000) { Set-Content -Path '$LogPath' -Value (`$lines | Select-Object -Last 2000) }
} catch { }
"@

# Set-Content's BOM and CRLF, and the generation date, are not differences in what a pass DOES, so all three come
# out before the two texts are compared -- with the date left in, every host reads as stale the day after setup.
function Comparable($text) {
    if (-not $text) { return '' }
    $t = ($text -replace "`r`n", "`n").TrimStart([char]0xFEFF)
    return ($t -replace '(?m)^\$GeneratedOn = .*$', '').TrimEnd()
}

# Free space on the volume that carries both vhdx files, read on Windows because the distro's own `df` reports
# the sparse virtual size and cannot go down.
function HostFreeGb {
    try {
        $root = [System.IO.Path]::GetPathRoot($env:LOCALAPPDATA)
        return [math]::Round((New-Object System.IO.DriveInfo($root)).AvailableFreeSpace / 1GB, 1)
    } catch { return -1 }
}

if ($Check) {
    Step 'check only -- nothing was registered or changed.'
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Step "the '$TaskName' task is registered." } else { Warn "the '$TaskName' task is NOT registered -- nothing starts this fleet after a reboot." }

    # An exact text compare, not an age: the question is whether this host's pass differs from the one this
    # file writes now, and every guard added since a difference appeared is not running here.
    if (-not (Test-Path $Reconciler)) {
        Warn "there is NO reconciler at $Reconciler -- nothing has ever been set up on this machine. Re-run without -Check."
    } elseif ((Comparable (Get-Content $Reconciler -Raw -ErrorAction SilentlyContinue)) -eq (Comparable $reconcilerBody)) {
        Step 'the deployed reconciler is the one this script writes.'
    } else {
        $age = (Get-Item $Reconciler).LastWriteTime.ToString('yyyy-MM-dd')
        Warn "the deployed reconciler is STALE: $Reconciler was generated $age and differs from what this script writes now, so every guard added to it since that date is NOT running on this machine -- including, depending how far back it goes, the whole of the disk section. Re-run without -Check."
    }

    # Read before the docker probe below, because it is what explains a wedged engine: a daemon whose data disk
    # cannot extend stops answering rather than erroring, and the ext4 inside docker_data.vhdx goes read-only.
    $freeGb = HostFreeGb
    if ($freeGb -lt 0) { Warn 'disk: could not read free space on this host.' }
    elseif ($freeGb -lt $LowDiskGb) { Warn "disk: $freeGb GB free on this host, UNDER the $LowDiskGb GB floor. Free space before trusting anything below it, and before restarting Docker Desktop -- no restart holds until space is freed." }
    else { Step "disk: $freeGb GB free on this host." }

    # Check whether a container job can start before attempting repair.
    $server = (& wsl.exe -d $Distro -e /bin/sh -c 'docker version --format {{.Server.Version}}' 2>$null |
        ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ }) -join ''
    if ($server) { Step "the fleet's own docker answers in ${Distro}: server $server." }
    else { Warn "the fleet CANNOT RUN A CONTAINER JOB: no daemon answered 'docker version' inside $Distro, as the user the runners run as. Every job it takes fails before a step runs. Re-run without -Check: the pass links the shared mount's CLI back in, and re-applies Docker Desktop's WSL integration with 'docker desktop restart' when no job is working." }
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

# -- the runners whose .env just changed, restarted one by one as each goes idle ---------------------------------
# A listener reads .env when it starts, so the hook is inert until its runner restarts -- and restarting one
# mid-job fails that job, so each waits until no Runner.Worker of ITS OWN is running (the worker binary lives
# under the runner's directory, which is how six runners' workers are told apart). Bounded: a runner still busy
# at the deadline is named, and the next run of this script picks it up.
$pending = @($hookChanged)
$restartDeadline = (Get-Date).AddMinutes(15)
# After the pass above has finished, not during it: a pass that finds a unit mid-restart reads it as down and
# starts it a second time.
if ($pending.Count -gt 0) {
    $passDeadline = (Get-Date).AddMinutes(5)
    while ((Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State -eq 'Running' -and (Get-Date) -lt $passDeadline) { Start-Sleep -Seconds 5 }
}
while ($pending.Count -gt 0) {
    $still = @()
    foreach ($r in $pending) {
        $busy = (& wsl.exe -d $Distro -e /bin/sh -c "for p in `$(pgrep -x Runner.Worker); do readlink /proc/`$p/exe; done | grep -c '^$($r.Dir)/'" 2>$null |
            ForEach-Object { ($_ -replace "`0", '').Trim() }) -join ''
        if ($busy -eq '0') {
            & wsl.exe -d $Distro -u root -e systemctl restart $r.Unit 2>&1 | Out-Null
            Step "restarted $($r.Unit) while idle, so it reads the job-started hook."
        } else { $still += $r }
    }
    $pending = $still
    if ($pending.Count -eq 0) { break }
    if ((Get-Date) -ge $restartDeadline) {
        Warn "still busy after 15 minutes, so NOT restarted and not yet using the hook: $(($pending | ForEach-Object { $_.Unit }) -join ', '). Re-run this script when they are idle."
        break
    }
    Start-Sleep -Seconds 20
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

# A FLEET THAT IS UP AND CANNOT RUN A CONTAINER IS NOT READY. Until this block existed the script printed
# "ready" for exactly that machine: a distro that answers, six active units, and no docker on their PATH --
# which is the state that failed three pipelines on 7 September, each job dying in five seconds in Set up job
# before a single step ran. Every property above is about whether the fleet is LISTENING; this is the first one
# about whether the work it takes can start.
#
# ASKED THE WAY THE RUNNER ASKS IT: a non-login shell, because the runners are systemd services and a login
# shell's PATH is not theirs. And retried rather than asked once -- the pass above may have just started Docker
# Desktop, and an engine thirty seconds from answering is not a broken fleet.
$cliDeadline = (Get-Date).AddSeconds(90)
$server = ''
while ($true) {
    $server = (& wsl.exe -d $Distro -e /bin/sh -c 'docker version --format {{.Server.Version}}' 2>$null |
        ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ }) -join ''
    if ($server) { break }
    if ((Get-Date) -ge $cliDeadline) { break }
    Start-Sleep -Seconds 10
}
if (-not $server) {
    $where = (& wsl.exe -d $Distro -e /bin/sh -c 'command -v docker' 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() }) -join ''
    Die (@(
        "$Distro is up with $($units.Count) runner units active and CANNOT RUN A CONTAINER JOB, so this fleet would fail every job it takes in Set up job -- not at a step, before one.",
        $(if ($where) { "The fleet's docker is $where but no daemon answered through /var/run/docker.sock. If 'docker version' answers on Windows, this is Docker Desktop's WSL integration: the pass re-applies it when no job is working, and Docker Desktop's error dialog offers 'Restart the WSL integration'. If it does not, it is the engine." }
          else { "There is no docker on the fleet's PATH at all. Docker Desktop injects it, and /var/run/docker.sock, through its WSL integration: switch that on for $Distro under Docker Desktop, Settings, Resources, WSL integration. The pass links the shared mount's CLI in when it can find one, so this message means it found none -- Docker Desktop's own docker-desktop distro is down, or the integration has never been applied on this machine." }),
        "Read $LogPath for what the pass found and tried."
    ) -join ' ')
}

Write-Host ''
Step "ready: $Distro is up with $($units.Count) runner units active."
Step "the fleet's own docker answers in $Distro (server $server), so a container job can start. That is the property nothing checked on 7 September, when the engine answered on Windows all day and every job died on 'docker: command not found'; the pass now asks it too, links the shared mount's CLI back in, and re-applies a dropped integration with 'docker desktop restart' once no job is working. A job that lands meanwhile waits for docker in its job-started hook ($HookPath) for up to $DockerWaitSeconds s."
Step "it is reconciled at every sign-in and every $WatchdogMinutes minutes ($repetition, read back off the registered task) -- nothing to keep open, nothing to babysit."
Step "every probe is bounded ($EngineProbeSeconds s for the engine), so a wedged docker can no longer park a pass and take the supervision down with it."
Step "free space on this host is read and logged every pass, and rebuildable docker state is reclaimed under $LowDiskGb GB. Nothing tagged and no volume is ever pruned -- this daemon also runs your sandboxes."
Step "the pass logs to $LogPath."
if (-not $LauncherPath) { Warn 'without the launcher stub this task maps a console window for a moment on every pass, on the machine whose desktop tiers read window titles. See -LauncherPath.' }
Step 'after an unattended reboot this still waits for a sign-in. Windows signs itself back in after its own update restarts; for anything else, see -AutoLogon in setup-windows-runner.ps1.'
