#!/usr/bin/env bash
# Pause idle WSL worker units during Windows smoke jobs to avoid shared-VM resource contention; busy jobs finish first.
# A runtime ConditionPathExists drop-in holds them down against the watchdog; a runtime mask cannot override /etc unit files.
# Arm a failsafe resume timer before stopping units; the job also resumes in always(), and reboot clears all pause state under /run.
# WORKERS_UNITS selects units; WORKERS_WAIT_MINUTES bounds how long a busy worker is waited on at all.
# `pause <failsafe-minutes> [block-minutes]` returns once every worker is stopped or block-minutes have passed (default: the
# whole wait). A worker still busy then is handed to a transient systemd unit that stops it the moment its job ends, so the
# caller starts beside at most the jobs already running, and no worker takes a new one. Run pause or resume as root.
set -uo pipefail

UNITS_GLOB=${WORKERS_UNITS:-actions.runner.*-worker-*.service}
WAIT_MINUTES=${WORKERS_WAIT_MINUTES:-40}
RUN_DIR=/run/intentic-ci
FLAG=$RUN_DIR/workers-paused
RESUME=$RUN_DIR/resume-workers.sh
DROPIN=intentic-paused.conf
TIMER=intentic-ci-workers-resume
# The watchers a capped pause hands its still-busy workers to, and the copy of this script they run: written into /run like
# the resume, so they need nothing of a checkout the next job may already have replaced.
DRAIN=intentic-ci-workers-drain
SELF=$RUN_DIR/wsl-workers.sh

say() { echo "wsl-workers: $*"; }

if [ "$(id -u)" -ne 0 ]; then
    say "run me as root (wsl.exe -d <distro> -u root ...): pausing a runner unit is systemd's business"
    exit 2
fi

mapfile -t UNITS < <(systemctl list-unit-files "$UNITS_GLOB" --no-legend --plain 2>/dev/null | awk '{ print $1 }')

# The runner directories whose Runner.Worker is alive, i.e. that are executing a job right now, as the CI fleet service reads them (_devices/machine src/ci-fleet/discover.ts).
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
        echo "systemctl stop '$DRAIN-*.service' 2>/dev/null"
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
# its next job in between (a broker round trip and a .NET process start, against a quarter of a second). Gives up at
# <deadline> (epoch seconds) with status 1, the worker still running its job. Stops nothing once the pause is lifted.
stop_when_idle() {
    local unit=$1 deadline=$2 dir name said=0
    dir=$(systemctl show -p WorkingDirectory --value "$unit")
    name=${unit#actions.runner.}
    name=${name%.service}
    while busy "$dir"; do
        [ -e "$FLAG" ] || return 0
        if [ "$(date +%s)" -ge "$deadline" ]; then
            return 1
        fi
        if [ "$said" -eq 0 ]; then
            say "$name: running a job; stopping it the moment that job ends"
            said=1
        fi
        sleep 0.25
    done
    [ -e "$FLAG" ] || return 0
    systemctl stop "$unit"
    say "$name: paused"
}

# The watcher a capped pause leaves behind for one worker: `drain <unit> <give-up-epoch>`, run by systemd from $SELF.
drain() {
    local unit=$1 give_up=$2 name
    name=${unit#actions.runner.}
    name=${name%.service}
    if ! stop_when_idle "$unit" "$give_up"; then
        say "$name: still running a job after $WAIT_MINUTES min; left running, and paused once that job ends is not promised"
    fi
}

pause() {
    local failsafe=${1:-} block=${2:-$WAIT_MINUTES}
    if ! [[ "$failsafe" =~ ^[0-9]+$ ]] || [ "$failsafe" -lt 1 ]; then
        say "pause needs the failsafe in minutes: how long until the workers come back on their own"
        exit 2
    fi
    if ! [[ "$block" =~ ^[0-9]+$ ]]; then
        say "pause's second argument is how many minutes to wait for busy workers, a whole number"
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
    local start give_up block_until pids=() unit i left=0 handed=0 name
    start=$(date +%s)
    give_up=$((start + WAIT_MINUTES * 60))
    block_until=$((start + block * 60))
    [ "$block_until" -le "$give_up" ] || block_until=$give_up
    for unit in "${UNITS[@]}"; do
        stop_when_idle "$unit" "$block_until" &
        pids+=("$!")
    done
    cp -- "${BASH_SOURCE[0]}" "$SELF" 2>/dev/null && chmod 755 "$SELF"
    for i in "${!UNITS[@]}"; do
        wait "${pids[$i]}" && continue
        unit=${UNITS[$i]}
        name=${unit#actions.runner.}
        name=${name%.service}
        # Still busy at the cap: the caller goes ahead, and a watcher stops this worker when its job ends.
        if [ "$block_until" -lt "$give_up" ] && [ -x "$SELF" ] &&
            systemd-run --quiet --collect --unit="$DRAIN-$name" --description="Pause $name once its job ends" \
                /bin/bash "$SELF" drain "$unit" "$give_up"; then
            say "$name: still running a job after $block min; it pauses the moment that job ends"
            handed=$((handed + 1))
        else
            say "$name: still running a job after $block min; left running, and paused once that job ends is not promised"
            left=$((left + 1))
        fi
    done
    say "paused $((${#UNITS[@]} - left - handed)) of ${#UNITS[@]} worker unit(s)$([ "$handed" -eq 0 ] || echo "; $handed more as their jobs end")"
}

resume() {
    if [ -x "$RESUME" ]; then
        "$RESUME"
    elif [ "${#UNITS[@]}" -gt 0 ]; then
        # Nothing of a pause is on file (it never ran, or a VM restart emptied /run): starting the units is still
        # the right end state, and a no-op for one already running.
        rm -f "$FLAG"
        systemctl stop "$DRAIN-*.service" 2>/dev/null
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
    rm -f "$RESUME" "$SELF"
}

case "${1:-}" in
    pause) pause "${2:-}" "${3:-}" ;;
    resume) resume ;;
    drain) drain "${2:-}" "${3:-0}" ;;
    *)
        say "usage: wsl-workers.sh pause <failsafe-minutes> [block-minutes] | resume"
        exit 2
        ;;
esac
