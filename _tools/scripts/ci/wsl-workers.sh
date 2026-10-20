#!/usr/bin/env bash
# wsl-workers.sh -- takes the WSL fleet's worker runners off this machine for the length of a Windows smoke job,
# and always gives them back.
#
#   wsl-workers.sh pause <failsafe-minutes>    run as root inside the fleet's distro
#   wsl-workers.sh resume
#
# WHY. The Windows runner and the six worker runners share one machine, and the workers share one WSL2 VM with
# Docker Desktop and with the engine tier's own distro. On 2026-10-20 the nightly's engine move ran while all six
# workers ran typechecks of their own: the VM could no longer allocate a vsock channel ("hvs_probe ... page
# allocation failure", then the relay's "UtilAcceptVsock: accept4 failed 110"), so every docker call from Windows
# to the engine's named pipe hung, and `docker stop` of the second sandbox timed out mid-move. A smoke tier that
# depends on what the fleet happens to be running that minute measures the fleet, not the product.
#
# PAUSE stops each worker unit only once it is idle: a busy one is watched, and stopped the moment its job ends,
# so no job is cut. The workers are kept down by a runtime drop-in (`ConditionPathExists=!<flag>`), because the
# fleet's watchdog (setup-wsl-fleet.ps1, section 4) starts every inactive runner unit every few minutes, and a
# runtime mask does not hold against a unit file in /etc. While the flag exists a start is a no-op that succeeds,
# so the watchdog's pass neither fails nor brings a worker back.
#
# GIVEN BACK THREE WAYS, so a paused fleet never outlives the job that paused it:
#   1. the job's own `if: always()` step runs `resume`, whatever the tiers did;
#   2. a transient systemd timer armed BEFORE anything is stopped runs the same resume after <failsafe-minutes>,
#      for a job that was cancelled, timed out, or lost its runner before step 1 could run;
#   3. every piece of the pause lives under /run, which a restart of the WSL VM empties: the units are `enabled`,
#      so a VM that comes back starts them as on any boot.
#
# Settings come from the environment: WORKERS_UNITS (the units to pause, as systemctl matches them) and
# WORKERS_WAIT_MINUTES (how long a busy worker may take to finish its job before the pause goes on without it).
set -uo pipefail

UNITS_GLOB=${WORKERS_UNITS:-actions.runner.*-worker-*.service}
WAIT_MINUTES=${WORKERS_WAIT_MINUTES:-40}
RUN_DIR=/run/intentic-ci
FLAG=$RUN_DIR/workers-paused
RESUME=$RUN_DIR/resume-workers.sh
DROPIN=intentic-paused.conf
TIMER=intentic-ci-workers-resume

say() { echo "wsl-workers: $*"; }

if [ "$(id -u)" -ne 0 ]; then
    say "run me as root (wsl.exe -d <distro> -u root ...): pausing a runner unit is systemd's business"
    exit 2
fi

mapfile -t UNITS < <(systemctl list-unit-files "$UNITS_GLOB" --no-legend --plain 2>/dev/null | awk '{ print $1 }')

# The runner directories whose Runner.Worker is alive, i.e. that are executing a job right now (fleet-janitor.sh).
busy() {
    pgrep -a -x Runner.Worker 2>/dev/null | awk '{ print $2 }' | sed -E 's#/bin[^/]*/Runner\.Worker$##' | grep -qxF -- "$1"
}

disarm_timer() {
    systemctl stop "$TIMER.timer" 2>/dev/null
    systemctl reset-failed "$TIMER.service" "$TIMER.timer" 2>/dev/null
    return 0
}

# The resume, written whole into /run at pause time, so the failsafe timer needs nothing of a checkout that the
# next job may already have replaced.
write_resume() {
    mkdir -p "$RUN_DIR"
    {
        echo '#!/usr/bin/env bash'
        echo "rm -f '$FLAG'"
        for unit in "${UNITS[@]}"; do
            echo "rm -f '/run/systemd/system/$unit.d/$DROPIN'; rmdir '/run/systemd/system/$unit.d' 2>/dev/null"
        done
        echo 'systemctl daemon-reload'
        for unit in "${UNITS[@]}"; do
            echo "systemctl start '$unit' || echo 'wsl-workers: could not start $unit'"
        done
        echo "echo 'wsl-workers: resumed ${#UNITS[@]} worker unit(s)'"
    } > "$RESUME"
    chmod 755 "$RESUME"
}

# Stops one worker as soon as it is idle; a busy one is watched closely enough that the listener cannot have taken
# its next job in between (a broker round trip and a .NET process start, against a quarter of a second).
stop_when_idle() {
    local unit=$1 dir name deadline said=0
    dir=$(systemctl show -p WorkingDirectory --value "$unit")
    name=${unit#actions.runner.}
    name=${name%.service}
    deadline=$((SECONDS + WAIT_MINUTES * 60))
    while busy "$dir"; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            say "$name: still running a job after $WAIT_MINUTES min; left running, and paused once that job ends is not promised"
            return 1
        fi
        if [ "$said" -eq 0 ]; then
            say "$name: running a job; stopping it the moment that job ends"
            said=1
        fi
        sleep 0.25
    done
    systemctl stop "$unit"
    say "$name: paused"
}

pause() {
    local failsafe=${1:-}
    if ! [[ "$failsafe" =~ ^[0-9]+$ ]] || [ "$failsafe" -lt 1 ]; then
        say "pause needs the failsafe in minutes: how long until the workers come back on their own"
        exit 2
    fi
    if [ "${#UNITS[@]}" -eq 0 ]; then
        say "no units matching $UNITS_GLOB in this distro: nothing to pause"
        exit 0
    fi
    # The way back first: from here on, whatever happens to this script or the job, the workers return.
    write_resume
    disarm_timer
    if ! systemd-run --quiet --unit="$TIMER" --description="Give the CI worker runners back after a Windows smoke job" \
        --on-active="${failsafe}m" --timer-property=AccuracySec=10s /bin/bash "$RESUME"; then
        say "could not arm the failsafe timer, so nothing is paused"
        exit 1
    fi
    : > "$FLAG"
    for unit in "${UNITS[@]}"; do
        mkdir -p "/run/systemd/system/$unit.d"
        printf '[Unit]\n# Written by wsl-workers.sh for a Windows smoke job; %s removes it.\nConditionPathExists=!%s\n' "$RESUME" "$FLAG" \
            > "/run/systemd/system/$unit.d/$DROPIN"
    done
    systemctl daemon-reload
    say "pausing ${#UNITS[@]} worker unit(s); they come back on their own in $failsafe min if nothing resumes them sooner"
    local pids=() unit
    for unit in "${UNITS[@]}"; do
        stop_when_idle "$unit" &
        pids+=("$!")
    done
    local left=0 pid
    for pid in "${pids[@]}"; do
        wait "$pid" || left=$((left + 1))
    done
    say "paused $((${#UNITS[@]} - left)) of ${#UNITS[@]} worker unit(s)"
}

resume() {
    if [ -x "$RESUME" ]; then
        "$RESUME"
    elif [ "${#UNITS[@]}" -gt 0 ]; then
        # Nothing of a pause is on file (it never ran, or a VM restart emptied /run): starting the units is still
        # the right end state, and a no-op for one already running.
        rm -f "$FLAG"
        for unit in "${UNITS[@]}"; do
            rm -f "/run/systemd/system/$unit.d/$DROPIN"
            rmdir "/run/systemd/system/$unit.d" 2>/dev/null
        done
        systemctl daemon-reload
        for unit in "${UNITS[@]}"; do
            systemctl start "$unit" || say "could not start $unit"
        done
        say "nothing was paused; ${#UNITS[@]} worker unit(s) asked to run"
    fi
    disarm_timer
    rm -f "$RESUME"
}

case "${1:-}" in
    pause) pause "${2:-}" ;;
    resume) resume ;;
    *)
        say "usage: wsl-workers.sh pause <failsafe-minutes> | resume"
        exit 2
        ;;
esac
