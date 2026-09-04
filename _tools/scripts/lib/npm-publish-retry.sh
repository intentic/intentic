#!/usr/bin/env bash
# Retry an npm publish that the transparency log — or the registry — dropped on its own side, and nothing else.
#
#   . "$(dirname "$0")/../lib/npm-publish-retry.sh"
#   npm_publish_retry @intentic/scaffold 1.243.0 "$out/intentic-scaffold-1.243.0.tgz" --access public --provenance
#
# EVERY TARBALL THIS REPO SHIPS IS SIGNED INTO A PUBLIC TRANSPARENCY LOG BEFORE THE REGISTRY SEES IT. That is
# what `--provenance` buys (npm-publish.yml says why it is non-negotiable): npm asks Fulcio for a short-lived
# certificate, signs the attestation with an ephemeral key, POSTs the entry to Rekor, and only then PUTs the
# tarball. Twenty-eight packages go through that in series, in one job, against public services shared with
# everyone else publishing that minute.
#
# REKOR REFUSES A REQUEST IT HAS ALREADY ANSWERED, AND @sigstore/sign IS THE ONE THAT ASKS TWICE. Its HTTP
# layer retries on 408, 429 and every 5xx of its own accord (external/fetch.js, DEFAULT_RETRY = two attempts),
# so an entry Rekor accepted but answered slowly, or 5xx'd after writing, is submitted again — and the second
# submission hits Rekor's duplicate guard:
#
#   npm error code TLOG_CREATE_ENTRY_ERROR
#   npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log
#     with UUID 108e9186e8c5677aa8f66c5a014567a7305f17347995aca633bcb65693ae9b2eeae21dcadefd7fa8
#
# That is what killed 1.243.0 (run 33875422034), on @intentic/scaffold — the TWENTIETH of the twenty-eight, 41
# seconds into a signing step the three packages before it had finished in about 20. Nineteen published, eight
# never attempted, a release half on npm and repairable only by hand. Nothing was wrong with the tarball, the
# token or this repository: the entry Rekor complained about was OUR OWN, from a request it had already taken.
#
# A SECOND PUBLISH IS A DIFFERENT SIGNATURE, which is why retrying fixes this rather than merely being worth a
# try. The signing key is minted per publish, so the next attempt offers Rekor an entry it has never seen and
# the duplicate guard has nothing to catch. The tarball is not re-packed and not re-built — the same bytes are
# signed again — so a retry costs one signature and one upload.
#
# A FAILED PUBLISH MAY STILL HAVE LANDED, so every failure asks the registry what it actually holds before
# deciding anything. The tarball PUT is the last thing npm does; when it is the ANSWER that is lost rather than
# the write, the version is on npm and a second attempt would read `EPUBLISHCONFLICT` — a fatal-looking error
# for a publish that succeeded. A version that is up is a version publish-npm.sh already treats as done (it
# skips versions already on npm), whatever exit status npm handed back, so that probe settles it either way and
# runs before the transient test rather than after it.
#
# ONLY THE FAR SIDE'S OWN STATE EARNS A SECOND ATTEMPT. A package whose trusted publisher was never registered,
# a tarball the registry rejects, the 422 a self-hosted runner earns for its builder id (publish-npm.sh asserts
# that one before the first pack) — every one of those must fail on the FIRST attempt, because three silent
# backoffs before the same error is how a red release becomes a slow red release that reads like a flake. So
# the decision is made on the command's own output, never on its exit status, which is 1 for all of them alike.
#
# BOTH DIRECTIONS ARE ASSERTED, against the text 1.243.0 actually printed, by the `publish-retry` check
# (_tools/checks/publish-retry.mjs, shared with registry-retry.sh) — which reads the pattern list below back
# out of this file rather than keeping a second copy, exercises all three loop properties (a dropped signature
# lands on the retry, a 4xx about us fails at once, a publish whose ANSWER was lost is reported as published),
# and refuses a caller that sources this without `set -o pipefail`.

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
