#!/usr/bin/env bash
# Retry what fails before BuildKit starts solving the build: a dropped connection while it lists workers, and a registry
# it could not connect to at all while resolving an image's metadata (the `# syntax=` frontend, a base), since nothing
# has run yet. Compile errors, registry refusals and timeouts mid-build retain their original status without a retry.
# The gap grows per attempt (5s, 10s, 15s): a runner losing its route out does so for seconds, not for one try
# (e2e and update-survival on z440, run 42359893687, both at 09:31:06-08).
BUILDKIT_RETRY_ATTEMPTS="${BUILDKIT_RETRY_ATTEMPTS:-4}"
BUILDKIT_RETRY_DELAY="${BUILDKIT_RETRY_DELAY:-5}"
set -o pipefail

buildkit_retry_transient() {
    grep -Eqi \
        -e 'listing workers for Build: failed to list workers:.*error reading server preface:.*use of closed network connection' \
        -e 'failed to resolve source metadata for .*dial tcp .*connect: (no route to host|network is unreachable|connection refused)' \
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
        echo "==> BuildKit lost its connection before the build began (attempt $attempt/$BUILDKIT_RETRY_ATTEMPTS); retrying in $((BUILDKIT_RETRY_DELAY * attempt))s" >&2
        sleep "$((BUILDKIT_RETRY_DELAY * attempt))"
        attempt=$((attempt + 1))
    done
}
