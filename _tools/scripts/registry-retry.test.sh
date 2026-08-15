#!/usr/bin/env bash
# Self-check for registry-retry.sh: the whole file is one decision — which failed registry write is worth a
# second attempt — and that decision is a list of patterns matched against buildkit's output. A pattern that
# stops matching costs a release (1.197.0 and 1.207.0 both died on a push that a retry would have carried),
# and one that matches too much costs twenty red minutes on a mistake that should have failed at once. So
# both directions are asserted here, against the failure text those releases actually printed.
# Run: bash _tools/scripts/registry-retry.test.sh   (no docker, no network)
set -uo pipefail
cd "$(dirname "$0")"
. ./registry-retry.sh

# Fast, so the whole file runs in a second: three attempts a second apart rather than four a minute apart.
export REGISTRY_RETRY_ATTEMPTS=3
export REGISTRY_RETRY_DELAY=1

fails=0
# registry_retry runs its command inside a pipeline (`"$@" | tee`), so the command's own body is a SUBSHELL
# and a counter variable it increments never comes back. The attempts are counted on disk instead.
counter="$(mktemp)"
trap 'rm -f "$counter"' EXIT

# name, the number of attempts the output should earn, the output a failing push printed.
case_() {
    local name="$1" expected="$2" output="$3" attempts
    : > "$counter"
    push() { echo x >> "$counter"; printf '%s\n' "$output"; return 1; }
    registry_retry push >/dev/null 2>&1
    attempts="$(wc -l < "$counter" | tr -d ' ')"
    if [ "$attempts" = "$expected" ]; then
        echo "ok   $name (attempts=$attempts)"
    else
        echo "FAIL $name (attempts=$attempts, expected $expected)"
        fails=1
    fi
}

# --- the failures that must be ridden out ---------------------------------------------------------------
# 1.207.0, verbatim from the images-amd64 job: 202 seconds of layers uploaded, then the registry disowned the
# upload session. The same commit's `images` lane pushed the identical bytes twenty minutes later.
case_ "blob upload unknown (killed 1.207.0)" 3 \
    'ERROR: failed to build: failed to solve: failed to push ghcr.io/intentic/sandbox:1.207.0-amd64: unknown: blob upload unknown to registry'
case_ "the same thing as an OCI error code" 3 \
    'failed commit on ref: unexpected status from PUT request: 404 Not Found: {"errors":[{"code":"BLOB_UPLOAD_UNKNOWN"}]}'
case_ "blob upload invalid" 3 'error: failed to push: blob upload invalid'
# 1.197.0, the refusal this helper was written for — a 403 whose body is a clock, not a permission.
case_ "secondary rate limit (killed 1.197.0)" 3 \
    'failed to push ghcr.io/intentic/sandbox:core-1.197.0-arm64: denied: permission_denied: 403 "Forbidden" You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'
case_ "a registry under load" 3 'failed to push: unexpected status: 503 Service Unavailable'
case_ "a dropped connection mid-upload" 3 'failed to push: read tcp: connection reset by peer'

# --- the failures that must be reported at once ---------------------------------------------------------
# A real permission_denied opens with the same words as a throttled one; only the body tells them apart.
case_ "a token that lacks packages:write" 1 \
    'failed to push ghcr.io/intentic/sandbox:1.0.0: denied: permission_denied: The token provided does not match the expected scopes.'
case_ "a broken Dockerfile" 1 'ERROR: failed to solve: dockerfile parse error on line 3: unknown instruction: RUNN'
case_ "a missing build context" 1 'ERROR: failed to solve: failed to compute cache key: "/opt/nothing": not found'
case_ "no login" 1 'ERROR: failed to push: unauthorized: authentication required'

# --- and the point of all of it -------------------------------------------------------------------------
# A push that the registry dropped once and accepted on the way back through is a GREEN release, not a red one.
: > "$counter"
flaky() {
    echo x >> "$counter"
    [ "$(wc -l < "$counter")" -ge 2 ] && { echo 'pushing layers 1.2s done'; return 0; }
    echo 'ERROR: failed to push ghcr.io/intentic/sandbox:1.207.0-amd64: unknown: blob upload unknown to registry'
    return 1
}
if registry_retry flaky >/dev/null 2>&1 && [ "$(wc -l < "$counter" | tr -d ' ')" = 2 ]; then
    echo "ok   a push dropped once succeeds on the retry"
else
    echo "FAIL a push dropped once succeeds on the retry"
    fails=1
fi

[ "$fails" = 0 ] && echo "registry-retry: all cases pass"
exit "$fails"
