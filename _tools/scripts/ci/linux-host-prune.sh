#!/usr/bin/env bash
# Docker and runner-log pruning for a native Linux CI host (setup-linux-runner.sh installs it with a 15-minute timer).
# On omen wsl-maintenance.ps1 does this from Windows; /ci-cache, runner _temp and buildkit state are fleet-janitor.sh's.
# Safe-while-busy work runs every pass. Image and volume pruning waits for an idle host, but no longer than
# PRUNE_FORCE_AFTER_HOURS, and not at all once / is PRUNE_PRESSURE_PERCENT full. PRUNE_DRY_RUN=1 only reports.
set -uo pipefail

STATE_DIR=${PRUNE_STATE_DIR:-/var/lib/intentic-ci}
RUNNERS_GLOB=${PRUNE_RUNNERS_GLOB:-/home/*/actions-runner-*}
RUNNER_CACHE=${PRUNE_RUNNER_CACHE:-/var/cache/intentic-ci}
# Unused images older than this go on every full pass; under pressure every unused image goes.
IMAGE_AGE=${PRUNE_IMAGE_AGE:-48h}
# The default builder's cache above this is pruned, least recently used first (dockerd's own gc does the same, in
# the background, from /etc/docker/daemon.json).
BUILD_CACHE_MAX=${PRUNE_BUILD_CACHE_MAX:-40GB}
# Runner _diag logs (one Worker_*.log per job) older than this.
DIAG_DAYS=${PRUNE_DIAG_DAYS:-14}
# A full pass waits for a moment with no job, but a host busy around the clock still gets one this often.
FORCE_AFTER_HOURS=${PRUNE_FORCE_AFTER_HOURS:-24}
# At this much of / used, a full pass runs now and takes every unused image and all build cache.
PRESSURE_PERCENT=${PRUNE_PRESSURE_PERCENT:-80}
DRY_RUN=${PRUNE_DRY_RUN:-0}

STAMP="$STATE_DIR/prune-full-at"
RESTART_FLAG="$STATE_DIR/docker-restart-pending"

log() { printf '%s\n' "$*"; }
run() {
    if [ "$DRY_RUN" = 1 ]; then log "would run: $*"; return 0; fi
    "$@" 2>&1 | grep -vE '^(Total reclaimed space: 0B|Total:[[:space:]]+0B|Deleted (Images|Containers|Networks|Volumes|build cache objects):)$' | sed 's/^/  /'
}
used_percent() { df --output=pcent / | tail -n1 | tr -dc '0-9'; }
idle() { ! pgrep -x Runner.Worker >/dev/null; }

mkdir -p "$STATE_DIR"
log "start: $(used_percent)% of / used; $(idle && echo 'no job running' || echo "jobs running: $(pgrep -cx Runner.Worker)")"

if ! timeout 20 docker version >/dev/null 2>&1; then
    log "docker is not answering; nothing pruned"
    exit 0
fi

# -- every pass: nothing a running job can still be using ---------------------------------------------------------
# A stopped container belongs to no running step; an untagged image has no name for a job to start; an unused
# network has no container; build cache records in use by a build are never pruned.
run docker container prune -f --filter until=24h
run docker network prune -f --filter until=24h
run docker image prune -f --filter until=1h
run docker builder prune -f --max-used-space "$BUILD_CACHE_MAX"

for runner in $RUNNERS_GLOB; do
    [ -d "$runner/_diag" ] || continue
    if [ "$DRY_RUN" = 1 ]; then
        n=$(find "$runner/_diag" -type f -name '*.log' -mtime +"$DIAG_DAYS" | wc -l)
        [ "$n" -gt 0 ] && log "would remove $n runner logs older than ${DIAG_DAYS}d in $runner/_diag"
    else
        find "$runner/_diag" -type f -name '*.log' -mtime +"$DIAG_DAYS" -delete
    fi
done
# setup-linux-runner.sh downloads one tarball per runner version; keep the newest.
if [ -d "$RUNNER_CACHE" ]; then
    mapfile -t old < <(ls -1t "$RUNNER_CACHE"/actions-runner-linux-*.tar.gz 2>/dev/null | tail -n +2)
    for f in "${old[@]}"; do run rm -f -- "$f"; done
fi

# -- full pass: tagged images and volumes --------------------------------------------------------------------------
# A job pulls its image and creates its container a moment later, and between the two nothing marks the image as
# used, so these wait for no job to be running. Overdue and pressure passes take that small risk on purpose: one
# job failing at "Initialize containers" is cheaper than a full disk failing all of them.
used=$(used_percent)
last=$(stat -c %Y "$STAMP" 2>/dev/null || echo 0)
since_hours=$(( ($(date +%s) - last) / 3600 ))
mode=
if [ "$used" -ge "$PRESSURE_PERCENT" ]; then mode=pressure
elif idle; then mode=idle
elif [ "$since_hours" -ge "$FORCE_AFTER_HOURS" ]; then mode=overdue
fi

if [ -z "$mode" ]; then
    log "full pass: waiting for an idle moment (last one ${since_hours}h ago, forced at ${FORCE_AFTER_HOURS}h)"
else
    log "full pass ($mode)"
    if [ "$mode" = pressure ]; then
        run docker image prune -af
        run docker builder prune -af
    else
        run docker image prune -af --filter until="$IMAGE_AGE"
    fi
    # -a: named volumes too (compose projects, testcontainers). A volume any container still references, running
    # or stopped, is never unused; the intentic-cache builder's state is kept that way.
    run docker volume prune -af
    [ "$DRY_RUN" = 1 ] || touch "$STAMP"
    if [ "$mode" = pressure ] && [ "$(used_percent)" -ge "$PRESSURE_PERCENT" ]; then
        log "still $(used_percent)% used after pruning docker; starting the janitor for /ci-cache"
        [ "$DRY_RUN" = 1 ] || systemctl start --no-block intentic-ci-janitor.service
    fi
fi

# -- a daemon.json change setup-linux-runner.sh left for an idle moment ------------------------------------------
# A restart stops every container that live-restore does not keep, so only with no job running.
if [ -f "$RESTART_FLAG" ] && idle && [ "$DRY_RUN" != 1 ]; then
    log "restarting docker for its new daemon.json"
    rm -f "$RESTART_FLAG"
    systemctl restart docker || log "docker did not restart cleanly; journalctl -u docker"
fi

log "done: $(df -h --output=used,avail / | tail -n1 | awk '{ print $1 " used, " $2 " free on /" }')"
exit 0
