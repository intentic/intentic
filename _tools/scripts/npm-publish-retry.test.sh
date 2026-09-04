#!/usr/bin/env bash
# Self-check for npm-publish-retry.sh: the whole file is two decisions — did this publish land anyway, and is
# this failure one to sign again for — and the second is a list of patterns matched against npm's output. A
# pattern that stops matching costs a release half-published (1.243.0 died on a transparency-log duplicate a
# retry would have carried, nineteen packages in), and one that matches too much turns a wrong token or an
# unregistered trusted publisher into a minute of backoff before the same error. So both directions are
# asserted here, against the failure text those publishes actually printed.
# Run: bash _tools/scripts/npm-publish-retry.test.sh   (no npm, no network)
set -uo pipefail
cd "$(dirname "$0")"
. ./npm-publish-retry.sh

# Fast, so the whole file runs in well under a second: the decision under test is WHICH failure is signed
# again, never how long it waits first, and thirteen cases of real backoff is half a minute of sleeping.
export NPM_PUBLISH_ATTEMPTS=3
export NPM_PUBLISH_DELAY=0

fails=0
# npm_publish_retry runs npm inside a pipeline (`npm publish | tee`), so the stub's body is a SUBSHELL and a
# counter it increments never comes back. The attempts are counted on disk instead, and so is the registry's
# answer, which each case sets before it runs.
counter="$(mktemp)"
landed="$(mktemp)"
trap 'rm -f "$counter" "$landed"' EXIT
OUTPUT=""

# The stub npm, standing in for both halves of what the helper asks: `publish` prints the failure under test
# and counts the attempt, `view` says whether the registry holds the version.
npm() {
    case "$1" in
        publish) echo x >> "$counter"; printf '%s\n' "$OUTPUT"; return 1 ;;
        view) [ "$(cat "$landed")" = yes ] ;;
    esac
}

attempts() { wc -l < "$counter" | tr -d ' '; }

# name, the number of attempts the output should earn, the output a failing publish printed.
case_() {
    local name="$1" expected="$2" count
    OUTPUT="$3"
    : > "$counter"
    echo no > "$landed"
    npm_publish_retry @intentic/scaffold 1.243.0 fake.tgz --access public --provenance >/dev/null 2>&1
    count="$(attempts)"
    if [ "$count" = "$expected" ]; then
        echo "ok   $name (attempts=$count)"
    else
        echo "FAIL $name (attempts=$count, expected $expected)"
        fails=1
    fi
}

# --- the failures that must be signed again ---------------------------------------------------------------
# 1.243.0, verbatim from the publish job: @sigstore/sign resubmitted an entry Rekor had already accepted, and
# Rekor's duplicate guard refused its own work back.
case_ "duplicate transparency-log entry (killed 1.243.0)" 3 \
    'npm error code TLOG_CREATE_ENTRY_ERROR
npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID 108e9186e8c5677aa8f66c5a014567a7305f17347995aca633bcb65693ae9b2eeae21dcadefd7fa8
npm error cause (409) an equivalent entry already exists in the transparency log with UUID 108e9186e8c5677aa8f66c5a014567a7305f17347995aca633bcb65693ae9b2eeae21dcadefd7fa8'
case_ "the same thing with only the cause line" 3 \
    'npm error cause (409) an equivalent entry already exists in the transparency log with UUID 108e9186'
# The other two witnesses npm talks to before the registry, having the same kind of moment.
case_ "fulcio would not issue the certificate" 3 \
    'npm error code CA_CREATE_SIGNING_CERTIFICATE_ERROR
npm error error creating signing certificate - (500) Internal Server Error'
case_ "the timestamp authority timed out" 3 'npm error code TSA_CREATE_TIMESTAMP_ERROR'
# The registry saying "later", in both shapes npm prints it.
case_ "the registry under load" 3 \
    'npm error code E503
npm error 503 Service Unavailable - PUT https://registry.npmjs.org/@intentic%2fscaffold'
case_ "too many publishes too fast" 3 'npm error code E429'
case_ "a dropped connection mid-upload" 3 'npm error code ECONNRESET'
case_ "a connection that went quiet" 3 \
    'npm error request to https://registry.npmjs.org/@intentic%2fscaffold failed, reason: socket hang up'

# --- the failures that must be reported at once -----------------------------------------------------------
# The 422 a self-hosted runner earns for its builder id: a 4xx about US, and it is already asserted before the
# first pack (publish-npm.sh). Backing off three times would only make it slower to read.
case_ "provenance from the wrong runner" 1 \
    'npm error code E422
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/@intentic%2fscaffold - Unsupported GitHub Actions runner environment: "self-hosted"'
case_ "a trusted publisher nobody registered" 1 \
    'npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/'
case_ "a token that cannot publish this name" 1 \
    'npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/@intentic%2fscaffold - You do not have permission to publish "@intentic/scaffold".'
case_ "a tarball the registry will not take" 1 \
    'npm error code EBADPLATFORM
npm error Invalid package.json: name can only contain URL-friendly characters'
# A version that is genuinely already up, and NOT ours: the probe below is what tells the two apart, so with
# the registry saying no this has to be reported rather than retried.
case_ "a conflict the registry does not confirm" 1 \
    'npm error code EPUBLISHCONFLICT
npm error You cannot publish over the previously published versions: 1.243.0.'

# --- and the point of all of it -----------------------------------------------------------------------------
# A publish Rekor dropped once and took on the way back through is a GREEN release, not a half-published one.
: > "$counter"
echo no > "$landed"
flaky() {
    case "$1" in
        publish)
            echo x >> "$counter"
            [ "$(wc -l < "$counter")" -ge 2 ] && { echo '+ @intentic/scaffold@1.243.0'; return 0; }
            echo 'npm error code TLOG_CREATE_ENTRY_ERROR'
            echo 'npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log'
            return 1 ;;
        view) [ "$(cat "$landed")" = yes ] ;;
    esac
}
if npm() { flaky "$@"; } && npm_publish_retry @intentic/scaffold 1.243.0 fake.tgz >/dev/null 2>&1 && [ "$(attempts)" = 2 ]; then
    echo "ok   a publish the transparency log dropped once succeeds on the retry"
else
    echo "FAIL a publish the transparency log dropped once succeeds on the retry"
    fails=1
fi

# And a publish whose ANSWER was lost is already done: the registry holds the version, so the conflict npm
# reports is our own write coming back, not a reason to fail the release.
npm() {
    case "$1" in
        publish) echo x >> "$counter"; printf '%s\n' 'npm error code EPUBLISHCONFLICT
npm error You cannot publish over the previously published versions: 1.243.0.'; return 1 ;;
        view) [ "$(cat "$landed")" = yes ] ;;
    esac
}
: > "$counter"
echo yes > "$landed"
if npm_publish_retry @intentic/scaffold 1.243.0 fake.tgz >/dev/null 2>&1 && [ "$(attempts)" = 1 ]; then
    echo "ok   a publish that landed without answering is reported as published"
else
    echo "FAIL a publish that landed without answering is reported as published"
    fails=1
fi

[ "$fails" = 0 ] && echo "npm-publish-retry: all cases pass"
exit "$fails"
