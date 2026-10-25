#!/usr/bin/env bash
# Retry only output-confirmed registry transients: rate limits, lost blob uploads, connect/header timeouts and blob HEAD refusals.
# Push retries reuse cached builds and uploaded blobs; genuine auth/manifest refusals, missing tags and build errors fail immediately.
# Classify output, not exit status: unrelated failures also exit 1. Callers must enable pipefail so failed pushes reach this loop.
# _tools/checks/publish-retry.mjs covers retryable and fatal cases and checks callers' pipefail setting.

# Attempts and the base gap, in seconds. The gap grows per attempt (60s, 120s, 180s) because the limit is a
# rolling window and the first retry is the one most likely to still be inside it. Overridable so a caller
# that knows better — or a hand-run publish that would rather fail fast — can say so.
REGISTRY_RETRY_ATTEMPTS="${REGISTRY_RETRY_ATTEMPTS:-4}"
REGISTRY_RETRY_DELAY="${REGISTRY_RETRY_DELAY:-60}"

# The refusals worth a second attempt. Matched on the MESSAGE, never on the bare status line: a real
# permission_denied and a throttled one are the same "403 Forbidden: denied: permission_denied" up front and
# differ only in the body GHCR attaches. The rest of the list is the ordinary transport failure set — a
# registry under load dropping a connection mid-upload is the same "wait and try again" as an explicit 429.
#
# The blob-upload pair are the registry losing its own side of an upload it had accepted (unknown = the
# session is gone, invalid = it no longer matches what we are sending). Both are state ON THE REGISTRY, never
# anything this repo can get wrong, so neither can mask a mistake of ours the way a broader status match
# would.
registry_retry_transient() {
    grep -Eqi \
        -e 'exceeded a secondary rate limit' \
        -e 'toomanyrequests' \
        -e '(status|code)[: ]+429' \
        -e '429 too many requests' \
        -e 'blob upload (unknown|invalid)' \
        -e 'blob_upload_(unknown|invalid)' \
        -e 'unexpected status: 50[0-9]' \
        -e '(502 bad gateway|503 service unavailable|504 gateway time)' \
        -e 'connection reset by peer' \
        -e 'unexpected eof' \
        -e '(tls handshake|i/o) timeout' \
        -e 'timeout awaiting response headers' \
        -e 'client\.timeout exceeded' \
        -e 'connectex: a connection attempt failed' \
        -e 'dial tcp.*(connection refused|connection timed out|no route to host)' \
        -e 'failed to fetch oauth token' \
        -e 'unexpected status from HEAD request to https://ghcr\.io/v2/[^ ]+/blobs/sha256:[0-9a-f]+: 401 Unauthorized' \
        -- "$1"
}

# Run a command, streaming its output as it goes (a 20-minute image build must not go quiet for the sake of
# being retryable) while keeping a copy to judge a failure by.
registry_retry() {
    local attempt=1 status delay log
    log="$(mktemp)"
    while :; do
        status=0
        # pipefail (every caller sets it) makes this the command's own status, not tee's.
        "$@" 2>&1 | tee "$log" || status=$?
        if [ "$status" -eq 0 ]; then
            rm -f "$log"
            return 0
        fi
        if [ "$attempt" -ge "$REGISTRY_RETRY_ATTEMPTS" ] || ! registry_retry_transient "$log"; then
            rm -f "$log"
            return "$status"
        fi
        delay=$((REGISTRY_RETRY_DELAY * attempt))
        echo "==> the registry dropped this call (attempt $attempt/$REGISTRY_RETRY_ATTEMPTS) — waiting ${delay}s and trying again" >&2
        sleep "$delay"
        attempt=$((attempt + 1))
    done
}
