#!/usr/bin/env bash
# Retry BuildKit's own transient faults: a dropped connection while it lists workers, a registry it could not connect
# to while resolving image metadata, and a lower snapshot that disappeared while applying a cached diff. Compile
# errors, registry refusals and timeouts mid-build retain their original status without a retry.
# The gap grows per attempt (5s, 10s, 15s): a runner losing its route out does so for seconds, not for one try
# (e2e and update-survival on z440, run 42359893687, both at 09:31:06-08).
# Worker discovery drops its socket on a write as well as a read (desktop-update on omen at load ~23, run 43000902296).
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

buildkit_retry() {
    local attempt=1 status log
    log="$(mktemp)"
    while :; do
        status=0
        "$@" 2>&1 | tee "$log" || status=$?
        if [ "$status" -eq 0 ]; then
            rm -f "$log"
            return 0
        fi
        if [ "$attempt" -ge "$BUILDKIT_RETRY_ATTEMPTS" ] || ! buildkit_retry_transient "$log"; then
            rm -f "$log"
            return "$status"
        fi
        echo "==> BuildKit hit a transient fault (attempt $attempt/$BUILDKIT_RETRY_ATTEMPTS); retrying in $((BUILDKIT_RETRY_DELAY * attempt))s" >&2
        sleep "$((BUILDKIT_RETRY_DELAY * attempt))"
        attempt=$((attempt + 1))
    done
}
