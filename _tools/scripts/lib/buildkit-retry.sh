#!/usr/bin/env bash
# Retry BuildKit's own transient faults: a dropped connection while it lists workers, a registry it could not connect
# to while resolving image metadata, and a lower snapshot that disappeared while applying a cached diff. Compile
# errors, registry refusals and timeouts mid-build retain their original status without a retry.
# The gap grows per attempt (5s, 10s, 15s): a runner losing its route out does so for seconds, not for one try
# (e2e and update-survival on z440, run 42359893687, both at 09:31:06-08).
# Worker discovery drops its socket on a write as well as a read (desktop-update on omen at load ~23, run 43000902296).
# A lost lower snapshot is retried once as it is (another build may have been collecting it at that moment). If the
# same fault comes back, the local cache record itself points at a snapshot that is gone, and every plain retry reads
# that record again: 4 of 4 attempts at core on omen died on the same snapshot (images, run 45162504225). From the
# second such fault on, `docker buildx build` is retried with --no-cache, which never consults the record.
BUILDKIT_RETRY_ATTEMPTS="${BUILDKIT_RETRY_ATTEMPTS:-4}"
BUILDKIT_RETRY_DELAY="${BUILDKIT_RETRY_DELAY:-5}"
set -o pipefail

buildkit_retry_transient() {
    grep -Eqi \
        -e 'listing workers( for Build)?: failed to list workers:.*(read|write) unix .*use of closed network connection' \
        -e 'failed to resolve source metadata for .*dial tcp .*connect: (no route to host|network is unreachable|connection refused)' \
        -e 'failed to apply diffs: failed to stat lower snapshot [^ ]+: snapshot [^ ]+ does not exist: not found' \
        -- "$1"
}

buildkit_retry_snapshot_lost() {
    grep -Eqi -e 'failed to stat lower snapshot [^ ]+: snapshot [^ ]+ does not exist' -- "$1"
}

# The command with --no-cache after its first `buildx build`, for wrappers too (`registry_retry docker buildx build`).
# A command without one, or already carrying --no-cache, is left as it was.
buildkit_retry_uncached() {
    local arg previous="" inserted=0
    BUILDKIT_RETRY_ARGV=()
    for arg in "$@"; do
        [ "$arg" = "--no-cache" ] && inserted=1
    done
    for arg in "$@"; do
        BUILDKIT_RETRY_ARGV+=("$arg")
        if [ "$inserted" -eq 0 ] && [ "$previous" = "buildx" ] && [ "$arg" = "build" ]; then
            BUILDKIT_RETRY_ARGV+=(--no-cache)
            inserted=1
        fi
        previous="$arg"
    done
}

buildkit_retry() {
    local attempt=1 status log lost=0
    local -a command=("$@")
    log="$(mktemp)"
    while :; do
        status=0
        "${command[@]}" 2>&1 | tee "$log" || status=$?
        if [ "$status" -eq 0 ]; then
            rm -f "$log"
            return 0
        fi
        if [ "$attempt" -ge "$BUILDKIT_RETRY_ATTEMPTS" ] || ! buildkit_retry_transient "$log"; then
            rm -f "$log"
            return "$status"
        fi
        echo "==> BuildKit hit a transient fault (attempt $attempt/$BUILDKIT_RETRY_ATTEMPTS); retrying in $((BUILDKIT_RETRY_DELAY * attempt))s" >&2
        if buildkit_retry_snapshot_lost "$log"; then
            lost=$((lost + 1))
            if [ "$lost" -ge 2 ]; then
                buildkit_retry_uncached "$@"
                command=("${BUILDKIT_RETRY_ARGV[@]}")
                echo "==> the same cached snapshot is still gone, so the next attempt builds without the local cache (--no-cache)" >&2
            fi
        fi
        sleep "$((BUILDKIT_RETRY_DELAY * attempt))"
        attempt=$((attempt + 1))
    done
}
