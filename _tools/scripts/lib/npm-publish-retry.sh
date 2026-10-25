#!/usr/bin/env bash
# Retry output-confirmed npm/attestation transients; genuine publisher, tarball and provenance refusals fail immediately.
# A fresh publish signs the same tarball with a new key, avoiding Rekor's duplicate-entry guard.
# Probe the registry after every failure: a lost response can hide a successful publish, which must not be published again.
# Callers need pipefail; _tools/checks/publish-retry.mjs tests transient, fatal and already-published outcomes.

# Attempts and the base gap, in seconds. The gap grows per attempt (15s, 30s) because a duplicate entry is
# usually Rekor under load rather than Rekor broken, and the load is what the next attempt wants to miss.
# Overridable so the self-check can run in a second and a hand-run publish can say "fail fast" instead.
NPM_PUBLISH_ATTEMPTS="${NPM_PUBLISH_ATTEMPTS:-3}"
NPM_PUBLISH_DELAY="${NPM_PUBLISH_DELAY:-15}"

# The failures worth signing again for. Matched on the MESSAGE, and deliberately narrow:
#
#   the sigstore witnesses      the three services npm talks to before the registry — Rekor's duplicate guard
#                               and its siblings at Fulcio and the timestamp authority. Each one is a shared
#                               public service having a moment; none of them can be something this repo got
#                               wrong, because the tarball they are signing has already been built.
#   the registry saying "later" 408, 429 and 5xx, in either shape npm prints them (`code E503`, and the bare
#                               status line the registry's own body carries). 4xx is absent on purpose: 401,
#                               403, 404 and 422 are all verdicts about US.
#   the transport               a connection dropped, timed out, or a DNS server asking to be asked again.
#                               Listed by code rather than caught by a general "request failed", so an expired
#                               certificate or a wrong registry host still fails at once.
npm_publish_transient() {
    grep -Eqi \
        -e 'tlog_create_entry_error' \
        -e 'equivalent entry already exists in the transparency log' \
        -e 'ca_create_signing_certificate_error' \
        -e 'tsa_create_timestamp_error' \
        -e 'code e(408|429|5[0-9][0-9])' \
        -e '(500 internal server error|502 bad gateway|503 service unavailable|504 gateway time)' \
        -e 'code (econnreset|etimedout|eai_again|err_socket_timeout)' \
        -e '(socket hang up|network timeout)' \
        -- "$1"
}

# npm_publish_retry <name> <version> <npm publish arguments...>
#
# Streams npm's output as it goes — a publish that signs for half a minute must not go quiet for the sake of
# being retryable — while keeping a copy to judge a failure by.
npm_publish_retry() {
    local name="$1" version="$2" attempt=1 status delay log
    shift 2
    log="$(mktemp)"
    while :; do
        status=0
        # pipefail (publish-npm.sh sets it) makes this npm's own status, not tee's.
        npm publish "$@" 2>&1 | tee "$log" || status=$?
        if [ "$status" -eq 0 ]; then
            rm -f "$log"
            return 0
        fi
        if npm view "$name@$version" version >/dev/null 2>&1; then
            rm -f "$log"
            echo "==> $name@$version is on npm after all — the write landed and the answer did not" >&2
            return 0
        fi
        if [ "$attempt" -ge "$NPM_PUBLISH_ATTEMPTS" ] || ! npm_publish_transient "$log"; then
            rm -f "$log"
            return "$status"
        fi
        delay=$((NPM_PUBLISH_DELAY * attempt))
        echo "==> $name@$version was refused by something on npm's side of the wire (attempt $attempt/$NPM_PUBLISH_ATTEMPTS) — waiting ${delay}s and signing it again" >&2
        sleep "$delay"
        attempt=$((attempt + 1))
    done
}
