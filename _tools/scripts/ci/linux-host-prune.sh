#!/usr/bin/env bash
# Docker and runner-log pruning for a native Linux CI host (setup-linux-runner.sh installs it with a 15-minute timer).
# On omen wsl-maintenance.ps1 does this from Windows; /ci-cache, runner _temp and buildkit state are fleet-janitor.sh's.
# Safe-while-busy work runs every pass. Image, build-cache and volume pruning waits for an idle host, but no longer than
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
# Whether containerd is writing content for docker right now. "Idle" only knows about CI jobs, but an image prune on
# the containerd image store takes the lease of ANY transfer in flight, CI's or not: at 2026-11-17 16:37:45 EST an idle
# pass on z440 took the lease of an `ic` sandbox move's 8.7 GB image load, which failed 47 s later ("commit failed:
# lease does not exist"). `ctr content active` lists every ingest not yet committed; a host without ctr, or on the
# classic image store, has nothing listed there and prunes as before.
ingesting() {
    command -v ctr >/dev/null || return 1
    [ -n "$(timeout 10 ctr -n moby content active 2>/dev/null | tail -n +2)" ]
}

mkdir -p "$STATE_DIR"
log "start: $(used_percent)% of / used; $(idle && echo 'no job running' || echo "jobs running: $(pgrep -cx Runner.Worker)")"

if ! timeout 20 docker version >/dev/null 2>&1; then
    log "docker is not answering; nothing pruned"
    exit 0
fi

# -- every pass: nothing a running job can still be using ---------------------------------------------------------
# A stopped CI container belongs to no running step; an unused network has no container. Untagged images and build
# cache are NOT safe while a job runs on the containerd image store (z440's): an image being pulled is untagged
# until its last blob lands, and the pass that pruned them at 2026-11-05 17:52:26 EST took a pull's lease and the
# ingest file under it, failing release 1.398.1's core smoke ("failed commit on ref ... rename .../ingest/...: no
# such file or directory"). They go with the full pass below; dockerd's own builder gc (daemon.json) still caps the
# default builder's cache meanwhile.
#
# Only what CI leaves behind. A container of a compose project (a Komodo stack, the platform) or an Intentic sandbox or
# runner (dev.intentic.kind) is a deployment, stopped or asleep, never CI's. `container prune --filter until=24h` took
# any stopped container created a day ago, and the volume prune below then took its named volumes in the same pass:
# on z440 a Komodo-run sandbox the keeper had put to sleep (2026-11-12, 1.3 GB) and the auto-translate stack's data
# after a reboot (2026-11-17, 9.7 GB). Same rule as wsl-maintenance.ps1 on omen. Listed here rather than passed as two
# `label!=` filters to `container prune`: with several, docker skips a container only if it carries all of them.
prune_stopped_containers() {
    local cutoff id created proj kind ids=()
    cutoff=$(( $(date +%s) - 24 * 3600 ))
    while IFS=$'\t' read -r id created proj kind; do
        [ -n "$id" ] || continue
        { [ -z "$proj" ] && [ -z "$kind" ]; } || continue
        # CreatedAt reads "2026-11-17 10:27:39 -0500 EST"; one that does not parse counts as young and stays.
        [ "$(date -d "${created% *}" +%s 2>/dev/null || echo "$cutoff")" -lt "$cutoff" ] || continue
        ids+=("$id")
    done < <(docker container ls -a --no-trunc --filter status=exited --filter status=created --filter status=dead \
        --format '{{.ID}}\t{{.CreatedAt}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "dev.intentic.kind"}}')
    if [ "${#ids[@]}" -gt 0 ]; then run docker container rm "${ids[@]}"; fi
}
prune_stopped_containers
run docker network prune -f --filter until=24h --filter 'label!=com.docker.compose.project'

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
    if [ "$mode" != pressure ] && ingesting; then
        log "images and build cache: left for the next pass, docker is writing an image (a pull, load or build)"
    else
        run docker image prune -f --filter until=1h
        run docker builder prune -f --max-used-space "$BUILD_CACHE_MAX"
        if [ "$mode" = pressure ]; then
            run docker image prune -af
            run docker builder prune -af
        else
            run docker image prune -af --filter until="$IMAGE_AGE"
        fi
    fi
    # Anonymous volumes, and of the named ones only what testcontainers made. Never -a over everything: a named
    # volume is unreferenced whenever its stack's container is gone, and it holds that deployment's data (a sandbox's
    # intentic-* volumes, a compose project's). The intentic-cache builder's state is named, and kept either way.
    run docker volume prune -f
    run docker volume prune -af --filter label=org.testcontainers=true
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
