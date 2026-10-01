#!/usr/bin/env bash
# fleet-janitor.sh -- keeps what the WSL CI fleet leaves behind on disk within fixed limits.
#
# setup-wsl-fleet.ps1 installs this into the runner distro as /usr/local/lib/intentic-ci/fleet-janitor.sh and
# runs it as root from the systemd timer intentic-ci-janitor.timer. Everything it removes is a cache: a job
# that finds it gone downloads again or builds cold. It never touches a tagged image, a docker volume, a
# checkout or node_modules.
#
# Measured on omen, 1 October 2026, with the distro's disk at 350 GB used and C: at 58 GB free:
#   six runners' _temp            75 GB  _temp/_github_home is the job container's $HOME. The runner (radarsu)
#                                        empties _temp before each job but cannot delete what a root job
#                                        container wrote, so npm/bun/pnpm caches piled up in every home.
#   /ci-cache/onboarding-docker   80 GB  the nightly onboarding job's own dockerd image store, which nothing pruned
#   /ci-cache/*-target            60 GB  nine cargo target dirs, each growing with every build
#   actions-work-N/.pnpm-store    28 GB  pnpm's default store for jobs that do not pass --store-dir
#   intentic-cache buildkit       93 GB  docker volume, in docker_data.vhdx, swept by age only while publishing
#
# Safe against running jobs: per-runner state is removed only while THAT runner has no Runner.Worker, and
# shared /ci-cache directories only while no runner has one. Anything removed is first renamed into a trash
# directory, so a job that starts mid-run never sees a half-deleted tree. Buildkit prunes only records no
# build is using, so it runs every pass.
#
# Settings come from the environment; the unit file sets none. JANITOR_DRY_RUN=1 reports and removes nothing.
set -uo pipefail

CACHE_ROOT=${JANITOR_CACHE_ROOT:-/ci-cache}
RUNNERS_GLOB=${JANITOR_RUNNERS_GLOB:-/home/*/actions-runner-*}
STATE_DIR=${JANITOR_STATE_DIR:-/var/lib/intentic-ci}
DRY_RUN=${JANITOR_DRY_RUN:-0}
# Per-runner pnpm store (actions-work-N/.pnpm-store): removed above this size.
WORKSPACE_STORE_CAP_GB=${JANITOR_WORKSPACE_STORE_CAP_GB:-6}
# /ci-cache/*-target: removed above this size, or when nothing in it was written for TARGET_STALE_DAYS.
TARGET_CAP_GB=${JANITOR_TARGET_CAP_GB:-20}
TARGET_STALE_DAYS=${JANITOR_TARGET_STALE_DAYS:-14}
# Every other /ci-cache entry: its own cap below, or this one.
CACHE_CAP_GB=${JANITOR_CACHE_CAP_GB:-15}
declare -A CACHE_CAPS=(
    [onboarding-docker]=${JANITOR_ONBOARDING_DOCKER_CAP_GB:-30}
    [pnpm-store]=${JANITOR_PNPM_STORE_CAP_GB:-20}
    [cargo]=${JANITOR_CARGO_CAP_GB:-20}
)
# /ci-cache/turbo: files older than a few days go first, and the whole directory only if that was not enough.
TURBO_CAP_GB=${JANITOR_TURBO_CAP_GB:-10}
# The docker-container builder publish-images.sh creates. Its state is a docker volume, not a /ci-cache path.
BUILDKIT_CONTAINER=${JANITOR_BUILDKIT_CONTAINER:-buildx_buildkit_intentic-cache0}
BUILDKIT_KEEP_GB=${JANITOR_BUILDKIT_KEEP_GB:-25}
# A run that frees at least this much, in the distro's disk and docker's together, leaves
# $STATE_DIR/compact-requested. Freed blocks go back to Windows only when a VHDX is compacted, which needs WSL
# shut down, so only the Windows-side maintenance task does it (wsl-maintenance.ps1 on omen reads this file).
COMPACT_REQUEST_GB=${JANITOR_COMPACT_REQUEST_GB:-40}

GB=$((1024 * 1024 * 1024))
TRASH="$STATE_DIR/trash"
freed=0
docker_freed=0

log() { printf '%s\n' "$*"; }

bytes_of() { du -sxb -- "$1" 2>/dev/null | cut -f1; }
# buildctl du prints decimal units ("99.36GB").
human_to_bytes() {
    awk -v s="$1" 'BEGIN { n = s + 0; u = s; sub(/^[0-9.]+/, "", u); m = 1
        if (u == "kB" || u == "KB") m = 1e3; else if (u == "MB") m = 1e6; else if (u == "GB") m = 1e9; else if (u == "TB") m = 1e12
        printf "%d", n * m }'
}
gb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / (1024 * 1024 * 1024) }'; }

# The runner directories whose Runner.Worker is alive, i.e. that are executing a job right now.
busy_runners() {
    # By process name: -f would also match any shell whose command line merely mentions Runner.Worker.
    pgrep -a -x Runner.Worker 2>/dev/null | awk '{ print $2 }' | sed -E 's#/bin[^/]*/Runner\.Worker$##' | sort -u
}
runner_busy() { busy_runners | grep -qxF -- "$1"; }
fleet_busy() { [ -n "$(busy_runners)" ]; }

work_folder() {
    local runner="$1" folder
    folder=$(sed -n 's/.*"workFolder"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$runner/.runner" 2>/dev/null | head -n1)
    [ -n "$folder" ] || folder=_work
    case "$folder" in /*) printf '%s\n' "$folder" ;; *) printf '%s\n' "$runner/$folder" ;; esac
}

# Renames into the trash first, so the path disappears atomically; the trash is emptied at the end of the run.
# Without a reason it logs nothing and leaves the size in $removed, for a caller that reports a whole batch.
removed=0
remove() {
    local path="$1" why="${2:-}" size
    removed=0
    [ -e "$path" ] || return 0
    size=$(bytes_of "$path")
    size=${size:-0}
    if [ "$DRY_RUN" = 1 ]; then
        removed=$size
        [ -n "$why" ] && log "would remove $path ($(gb "$size") GB): $why"
        return 0
    fi
    if mv -- "$path" "$TRASH/$(date +%s%N)-$(basename -- "$path")" 2>/dev/null || rm -rf -- "$path"; then
        removed=$size
        freed=$((freed + size))
        [ -n "$why" ] && log "removed $path ($(gb "$size") GB): $why"
    else
        log "could not remove $path"
    fi
    return 0
}

mkdir -p "$TRASH"
# The trash must sit on the same filesystem as what it receives, or every mv is a copy.
if [ "$(stat -c %d "$TRASH")" != "$(stat -c %d "$CACHE_ROOT" 2>/dev/null || stat -c %d /)" ]; then
    log "note: $TRASH is not on the same filesystem as $CACHE_ROOT; removals copy before deleting"
fi
# A run killed mid-way leaves its trash behind; it is garbage by definition.
rm -rf -- "${TRASH:?}"/* 2>/dev/null

log "start: $(df -h --output=used,avail / | tail -n1 | awk '{ print $1 " used, " $2 " free on /" }'); busy runners: $(busy_runners | xargs -r -n1 basename | tr '\n' ' ')"

# -- per runner: the job's leftovers, while that runner is idle ---------------------------------------------------
for runner in $RUNNERS_GLOB; do
    [ -f "$runner/.runner" ] || continue
    if runner_busy "$runner"; then continue; fi
    work=$(work_folder "$runner")
    temp="$work/_temp"
    if [ -d "$temp" ]; then
        count=0
        total=0
        # Older than ten minutes: a job that started since the check above creates its entries fresh.
        # The job's $HOME keeps .docker, which names the intentic-cache builder publish-images.sh reuses.
        while IFS= read -r -d '' entry; do
            runner_busy "$runner" && break
            remove "$entry"
            count=$((count + 1))
            total=$((total + removed))
        done < <(
            find "$temp" -mindepth 1 -maxdepth 1 ! -name _github_home -mmin +10 -print0 2>/dev/null
            [ -d "$temp/_github_home" ] && find "$temp/_github_home" -mindepth 1 -maxdepth 1 ! -name .docker -print0 2>/dev/null
        )
        if [ "$count" -gt 0 ]; then
            log "$([ "$DRY_RUN" = 1 ] && echo 'would remove' || echo removed) $count entries ($(gb "$total") GB) a finished job left in $temp"
        fi
    fi
    store="$work/.pnpm-store"
    if [ -d "$store" ]; then
        size=$(bytes_of "$store")
        if [ "${size:-0}" -gt $((WORKSPACE_STORE_CAP_GB * GB)) ] && ! runner_busy "$runner"; then
            remove "$store" "over the ${WORKSPACE_STORE_CAP_GB} GB cap for a per-runner pnpm store"
        fi
    fi
done

# -- turbo: by age, safe while jobs run (a reader keeps an unlinked file open) ---------------------------------------
turbo="$CACHE_ROOT/turbo"
if [ -d "$turbo" ]; then
    for days in 3 1; do
        size=$(bytes_of "$turbo")
        [ "${size:-0}" -gt $((TURBO_CAP_GB * GB)) ] || break
        if [ "$DRY_RUN" = 1 ]; then log "would delete turbo entries older than ${days}d ($(gb "$size") GB)"; break; fi
        find "$turbo" -type f -mtime +"$days" -delete 2>/dev/null
        after=$(bytes_of "$turbo")
        freed=$((freed + size - ${after:-0}))
        log "turbo: deleted entries older than ${days}d, $(gb "$size") -> $(gb "${after:-0}") GB"
    done
fi

# -- shared /ci-cache directories, only while the whole fleet is idle -----------------------------------------------
if fleet_busy; then
    log "shared caches: skipped, a job is running (the next idle pass takes them)"
else
    for dir in "$CACHE_ROOT"/*/; do
        dir=${dir%/}
        name=$(basename -- "$dir")
        [ "$name" = turbo ] && continue
        fleet_busy && { log "shared caches: a job started; stopping here"; break; }
        size=$(bytes_of "$dir")
        size=${size:-0}
        case "$name" in
            *-target)
                if [ -z "$(find "$dir" -maxdepth 3 -newermt "-${TARGET_STALE_DAYS} days" -print -quit 2>/dev/null)" ]; then
                    remove "$dir" "no build wrote to it in ${TARGET_STALE_DAYS} days"
                elif [ "$size" -gt $((TARGET_CAP_GB * GB)) ]; then
                    remove "$dir" "over the ${TARGET_CAP_GB} GB cap for a cargo target dir"
                fi
                ;;
            *)
                cap=${CACHE_CAPS[$name]:-$CACHE_CAP_GB}
                if [ "$size" -gt $((cap * GB)) ]; then
                    remove "$dir" "over its ${cap} GB cap"
                fi
                ;;
        esac
    done
fi

# -- the intentic-cache buildkit state (a docker volume) ------------------------------------------------------------
if command -v docker >/dev/null && timeout 20 docker version >/dev/null 2>&1; then
    if [ -n "$(docker ps -aq --filter "name=^${BUILDKIT_CONTAINER}\$" 2>/dev/null)" ]; then
        started=0
        if [ -z "$(docker ps -q --filter "name=^${BUILDKIT_CONTAINER}\$" 2>/dev/null)" ]; then
            [ "$DRY_RUN" = 1 ] || { docker start "$BUILDKIT_CONTAINER" >/dev/null 2>&1 && started=1; }
        fi
        before=$(timeout 300 docker exec "$BUILDKIT_CONTAINER" buildctl du 2>/dev/null | awk '/^Total:/ { print $2 }')
        if [ "$DRY_RUN" != 1 ] && [ -n "$before" ]; then
            timeout 1800 docker exec "$BUILDKIT_CONTAINER" buildctl prune --keep-storage $((BUILDKIT_KEEP_GB * 1024)) >/dev/null 2>&1 \
                || log "buildkit prune failed or timed out"
            after=$(timeout 300 docker exec "$BUILDKIT_CONTAINER" buildctl du 2>/dev/null | awk '/^Total:/ { print $2 }')
            if [ -n "$after" ]; then
                docker_freed=$(( $(human_to_bytes "$before") - $(human_to_bytes "$after") ))
                [ "$docker_freed" -gt 0 ] || docker_freed=0
            fi
            log "buildkit $BUILDKIT_CONTAINER: $before -> ${after:-unknown} (cap ${BUILDKIT_KEEP_GB} GB)"
        else
            log "buildkit $BUILDKIT_CONTAINER: ${before:-unknown} in use, cap ${BUILDKIT_KEEP_GB} GB"
        fi
        [ "$started" = 1 ] && docker stop "$BUILDKIT_CONTAINER" >/dev/null 2>&1
    fi
else
    log "docker not answering in this distro; buildkit left for the next pass"
fi

rm -rf -- "${TRASH:?}"/* 2>/dev/null

log "done: freed $(gb "$freed") GB on /, $(gb "$docker_freed") GB of buildkit state; $(df -h --output=used,avail / | tail -n1 | awk '{ print $1 " used, " $2 " free" }')"
if [ "$DRY_RUN" != 1 ] && [ $((freed + docker_freed)) -ge $((COMPACT_REQUEST_GB * GB)) ]; then
    printf '%s freed %s GB\n' "$(date -Is)" "$(gb $((freed + docker_freed)))" >> "$STATE_DIR/compact-requested"
    log "asked the Windows maintenance task to compact the disk ($STATE_DIR/compact-requested)"
fi
exit 0
