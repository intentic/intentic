#!/usr/bin/env bash
# Retry a registry write that GHCR refused for going too fast — and nothing else.
#
#   . "$(dirname "$0")/registry-retry.sh"
#   registry_retry docker buildx build ... --push "$context"
#
# ONE PIPELINE WRITES THE SANDBOX IMAGE SIX TIMES: two profiles (`standard` + `core-`) × two arches × the
# images and release lanes, every one of them ending in a manifest PUT to ghcr.io under the same token,
# inside about half an hour. GHCR answers a burst of those with a 403 whose body is not a permissions problem
# at all:
#
#   failed to push ghcr.io/intentic/sandbox:core-1.197.0-arm64: denied: permission_denied:
#   ... 403 "Forbidden" ... "You have exceeded a secondary rate limit. Please wait a few minutes ..."
#
# That is what killed the 1.197.0 release. The standard arm64 image pushed fine at 15:01:44; the core one —
# 37 seconds behind it, every layer already uploaded, "pushing layers 0.2s done" — was refused on the
# manifest alone, and the publish job behind it never ran. Nothing was wrong with the build, the token or the
# Dockerfile, and re-running the pipeline by hand is how it was cleared both times it happened.
#
# THE REFUSAL IS A CLOCK, SO WAITING IS THE ENTIRE FIX. Retrying is safe on top of that: a push is
# idempotent, the blobs that landed stay landed, and the build behind it is fully cached, so a second attempt
# costs one manifest PUT rather than a rebuild.
#
# ONLY THAT CLASS OF FAILURE RETRIES. A broken Dockerfile, a missing build context or a token that genuinely
# lacks `packages: write` must fail on the FIRST attempt — three silent backoffs before the same error is how
# a five-minute red pipeline becomes a twenty-minute one that reads like an infrastructure flake. So the
# decision is made on the command's own output, not on its exit status, which is 1 for all of them alike.

# Attempts and the base gap, in seconds. The gap grows per attempt (60s, 120s, 180s) because the limit is a
# rolling window and the first retry is the one most likely to still be inside it. Overridable so a caller
# that knows better — or a hand-run publish that would rather fail fast — can say so.
REGISTRY_RETRY_ATTEMPTS="${REGISTRY_RETRY_ATTEMPTS:-4}"
REGISTRY_RETRY_DELAY="${REGISTRY_RETRY_DELAY:-60}"

# The refusals worth a second attempt. Matched on the MESSAGE, never on the bare status line: a real
# permission_denied and a throttled one are the same "403 Forbidden: denied: permission_denied" up front and
# differ only in the body GHCR attaches. The rest of the list is the ordinary transport failure set — a
# registry under load dropping a connection mid-upload is the same "wait and try again" as an explicit 429.
registry_retry_transient() {
    grep -Eqi \
        -e 'exceeded a secondary rate limit' \
        -e 'toomanyrequests' \
        -e '(status|code)[: ]+429' \
        -e '429 too many requests' \
        -e 'unexpected status: 50[0-9]' \
        -e '(502 bad gateway|503 service unavailable|504 gateway time)' \
        -e 'connection reset by peer' \
        -e 'unexpected eof' \
        -e '(tls handshake|i/o) timeout' \
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
        echo "==> registry refused this write as too fast (attempt $attempt/$REGISTRY_RETRY_ATTEMPTS) — waiting ${delay}s and trying again" >&2
        sleep "$delay"
        attempt=$((attempt + 1))
    done
}
