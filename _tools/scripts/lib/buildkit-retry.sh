#!/usr/bin/env bash
# Retry a dropped connection while BuildKit lists workers, before it starts solving the build.
# Compile errors, registry refusals and timeouts retain their original status without a retry.
BUILDKIT_RETRY_ATTEMPTS="${BUILDKIT_RETRY_ATTEMPTS:-3}"
BUILDKIT_RETRY_DELAY="${BUILDKIT_RETRY_DELAY:-5}"
set -o pipefail

buildkit_retry_transient() {
    grep -Eqi \
        -e 'listing workers for Build: failed to list workers:.*error reading server preface:.*use of closed network connection' \
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
        echo "==> BuildKit lost its worker-discovery connection (attempt $attempt/$BUILDKIT_RETRY_ATTEMPTS); retrying in ${BUILDKIT_RETRY_DELAY}s" >&2
        sleep "$BUILDKIT_RETRY_DELAY"
        attempt=$((attempt + 1))
    done
}
