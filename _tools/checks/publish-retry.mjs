#!/usr/bin/env node
// Checks registry-retry.sh and npm-publish-retry.sh: each is a pattern list deciding which publish failure gets
// retried, asserted against failures that actually killed a release, in both directions. Patterns are read back out of
// the scripts, compiled as POSIX ERE case-insensitively; the backoff loop is drilled through bash when available.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root, trackedFiles } from "./lib/repo.mjs";

// Each drill prints one line per case, `<case> <attempts> <status>`. Delays are 0: there's no clock worth waiting out.

const SUBJECTS = [
    {
        id: "registry-retry",
        script: "_tools/scripts/lib/registry-retry.sh",
        predicate: "registry_retry_transient",
        // Verbatim from the runs that died; a paraphrase would assert less than the release cost to learn.
        rideItOut: [
            [
                "blob upload unknown (killed 1.207.0)",
                "ERROR: failed to build: failed to solve: failed to push ghcr.io/intentic/sandbox:1.207.0-amd64: unknown: blob upload unknown to registry",
            ],
            [
                "the same thing as an OCI error code",
                'failed commit on ref: unexpected status from PUT request: 404 Not Found: {"errors":[{"code":"BLOB_UPLOAD_UNKNOWN"}]}',
            ],
            ["blob upload invalid", "error: failed to push: blob upload invalid"],
            [
                "secondary rate limit (killed 1.197.0)",
                'failed to push ghcr.io/intentic/sandbox:core-1.197.0-arm64: denied: permission_denied: 403 "Forbidden" You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
            ],
            ["a registry under load", "failed to push: unexpected status: 503 Service Unavailable"],
            ["a dropped connection mid-upload", "failed to push: read tcp: connection reset by peer"],
            [
                "a connect that was never answered (killed 1.254.1)",
                'docker: Error response from daemon: failed to resolve reference "ghcr.io/intentic/sandbox:1.254.1-amd64": failed to do request: Head "https://ghcr.io/v2/intentic/sandbox/manifests/1.254.1-amd64": dialing ghcr.io:443 container via direct connection because Docker Desktop has no HTTPS proxy: connecting to ghcr.io:443: dial tcp 140.82.121.33:443: connectex: A connection attempt failed because the connected party did not properly respond after a period of time.',
            ],
            ["the same dial failure spelled the POSIX way", "failed to resolve reference: dial tcp 140.82.121.33:443: connect: connection timed out"],
        ],
        // A real permission_denied opens with the same words as a throttled one; only the body tells them apart.
        failAtOnce: [
            [
                "a token that lacks packages:write",
                "failed to push ghcr.io/intentic/sandbox:1.0.0: denied: permission_denied: The token provided does not match the expected scopes.",
            ],
            ["a broken Dockerfile", "ERROR: failed to solve: dockerfile parse error on line 3: unknown instruction: RUNN"],
            ["a missing build context", 'ERROR: failed to solve: failed to compute cache key: "/opt/nothing": not found'],
            ["no login", "ERROR: failed to push: unauthorized: authentication required"],
            // Verbatim from a real `docker pull` of a tag nobody pushed: the wrapper is word for word the one a
            // dropped dial arrives in, which is why the dial patterns are anchored on the transport line inside it.
            [
                "a tag that is not there",
                'Error response from daemon: failed to resolve reference "ghcr.io/intentic/sandbox:no-such-tag": ghcr.io/intentic/sandbox:no-such-tag: not found',
            ],
        ],
        // A push GHCR drops once and accepts on retry is a green release; a broken build fails on the first attempt.
        // Attempts are counted on disk, since `tee` puts the counted command in a subshell.
        drill: String.raw`
export REGISTRY_RETRY_ATTEMPTS=3 REGISTRY_RETRY_DELAY=0
DROPPED='ERROR: failed to push ghcr.io/intentic/sandbox:1.207.0-amd64: unknown: blob upload unknown to registry'
BROKEN='ERROR: failed to solve: dockerfile parse error on line 3: unknown instruction: RUNN'

flaky() {
    echo x >> "$count"
    [ "$(wc -l < "$count")" -ge 2 ] && { echo 'pushing layers 1.2s done'; return 0; }
    printf '%s\n' "$DROPPED"
    return 1
}
broken() { echo x >> "$count"; printf '%s\n' "$BROKEN"; return 1; }

run flaky  registry_retry flaky
run broken registry_retry broken
`,
        expect: { flaky: [2, 0], broken: [1, 1] },
    },
    {
        id: "npm-publish-retry",
        script: "_tools/scripts/lib/npm-publish-retry.sh",
        predicate: "npm_publish_transient",
        rideItOut: [
            [
                "duplicate transparency-log entry (killed 1.243.0)",
                "npm error code TLOG_CREATE_ENTRY_ERROR\nnpm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID 108e9186e8c5677aa8f66c5a014567a7305f17347995aca633bcb65693ae9b2ee",
            ],
            ["the same thing with only the cause line", "npm error cause (409) an equivalent entry already exists in the transparency log with UUID 108e9186"],
            [
                "fulcio would not issue the certificate",
                "npm error code CA_CREATE_SIGNING_CERTIFICATE_ERROR\nnpm error error creating signing certificate - (500) Internal Server Error",
            ],
            ["the timestamp authority timed out", "npm error code TSA_CREATE_TIMESTAMP_ERROR"],
            ["the registry under load", "npm error code E503\nnpm error 503 Service Unavailable - PUT https://registry.npmjs.org/@intentic%2fscaffold"],
            ["too many publishes too fast", "npm error code E429"],
            ["a dropped connection mid-upload", "npm error code ECONNRESET"],
            ["a connection that went quiet", "npm error request to https://registry.npmjs.org/@intentic%2fscaffold failed, reason: socket hang up"],
        ],
        failAtOnce: [
            [
                "provenance from the wrong runner",
                'npm error code E422\nnpm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/@intentic%2fscaffold - Unsupported GitHub Actions runner environment: "self-hosted"',
            ],
            ["a trusted publisher nobody registered", "npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in to https://registry.npmjs.org/"],
            [
                "a token that cannot publish this name",
                'npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/@intentic%2fscaffold - You do not have permission to publish "@intentic/scaffold".',
            ],
            ["a tarball the registry will not take", "npm error code EBADPLATFORM\nnpm error Invalid package.json: name can only contain URL-friendly characters"],
            // The landed-probe, not the exit code, decides an unconfirmed conflict must be reported, not retried.
            ["a conflict the registry does not confirm", "npm error code EPUBLISHCONFLICT\nnpm error You cannot publish over the previously published versions: 1.243.0."],
        ],
        // Three properties the pattern list alone can't show: a dropped signature re-signs and lands, a 4xx about us
        // fails at once, and a lost answer is reported as published, since the registry holds the version regardless of
        // npm's exit status.
        drill: String.raw`
export NPM_PUBLISH_ATTEMPTS=3 NPM_PUBLISH_DELAY=0
landed="$(mktemp)"
DUPLICATE='npm error code TLOG_CREATE_ENTRY_ERROR
npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log'
CONFLICT='npm error code EPUBLISHCONFLICT
npm error You cannot publish over the previously published versions: 1.243.0.'
FORBIDDEN='npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/@intentic%2fscaffold'

# The stub npm, standing in for both halves of what the helper asks: "publish" prints the failure under test
# and counts the attempt, "view" says whether the registry holds the version.
npm() {
    case "$1" in
        publish)
            echo x >> "$count"
            [ "$FLAKY" = yes ] && [ "$(wc -l < "$count")" -ge 2 ] && { echo '+ @intentic/scaffold@1.243.0'; return 0; }
            printf '%s\n' "$OUTPUT"
            return 1 ;;
        view) [ "$(cat "$landed")" = yes ] ;;
    esac
}

echo no > "$landed"; FLAKY=yes OUTPUT="$DUPLICATE"  run flaky       npm_publish_retry @intentic/scaffold 1.243.0 fake.tgz
echo no > "$landed"; FLAKY=no  OUTPUT="$FORBIDDEN"  run forbidden   npm_publish_retry @intentic/scaffold 1.243.0 fake.tgz
echo yes > "$landed"; FLAKY=no OUTPUT="$CONFLICT"   run lost-answer npm_publish_retry @intentic/scaffold 1.243.0 fake.tgz
rm -f "$landed"
`,
        expect: { flaky: [2, 0], forbidden: [1, 1], "lost-answer": [1, 0] },
    },
];

// The pattern lists, read back out of the scripts.

const problems = [];
const vouched = [];

for (const subject of SUBJECTS) {
    const source = readFileSync(join(root, subject.script), "utf8");
    // The predicate's body only, so other single-quoted text in the file isn't mistaken for a pattern.
    const body = source.match(new RegExp(String.raw`^${subject.predicate}\(\)\s*\{([\s\S]*?)^\}`, "m"));
    if (body === null) {
        problems.push(`${subject.script}: cannot find ${subject.predicate}(), the shape changed and this check needs updating`);
        continue;
    }
    const patterns = [...body[1].matchAll(/-e '([^']*)'/g)].map(([, pattern]) => pattern);
    if (patterns.length === 0) {
        problems.push(`${subject.script}: ${subject.predicate}() lists no -e patterns, so nothing decides which failure is retried`);
        continue;
    }

    const compiled = [];
    for (const pattern of patterns) {
        try {
            compiled.push({ pattern, regexp: new RegExp(pattern, "i") });
        } catch (error) {
            problems.push(`${subject.script}: ${pattern} does not compile: ${error.message}`);
        }
    }

    for (const [name, output] of subject.rideItOut) {
        if (!compiled.some(({ regexp }) => regexp.test(output))) {
            problems.push(`${subject.id}: "${name}" matches no pattern, so it would fail on the first attempt — this is a failure a retry carries`);
        }
    }
    for (const [name, output] of subject.failAtOnce) {
        const matched = compiled.filter(({ regexp }) => regexp.test(output)).map(({ pattern }) => pattern);
        if (matched.length > 0) {
            problems.push(`${subject.id}: "${name}" is matched by ${matched.join(", ")} — it must fail at once, not after three silent backoffs`);
        }
    }

    // Both helpers judge an attempt through `cmd | tee`, whose pipeline status is tee's own unless the caller sets
    // `pipefail`; without it every failure silently reports success. Checks that every caller sourcing the script also
    // sets it.
    const basename = subject.script.slice(subject.script.lastIndexOf("/") + 1);
    const sourcesIt = new RegExp(String.raw`^\s*\.\s+.*${basename.replace(/\./g, "\\.")}"`, "m");
    const setsPipefail = /^\s*set\b[^\n]*\bpipefail\b/m;
    for (const path of trackedFiles()) {
        if (!path.endsWith(".sh") || path === subject.script) {
            continue;
        }
        const text = readFileSync(join(root, path), "utf8");
        if (sourcesIt.test(text) && !setsPipefail.test(text)) {
            problems.push(`${path} sources ${basename} without \`set -o pipefail\`, so every failure there reports success and is never retried`);
        }
    }

    // The harness both drills share: runs one case, records the retry function's exit status, prints `<case> <attempts>
    // <status>`. The counter is a file, for the same subshell reason.
    const HARNESS = String.raw`
set -uo pipefail
. "$SCRIPT"
count="$(mktemp)"
trap 'rm -f "$count"' EXIT
run() {
    local case_name="$1" status=0
    shift
    : > "$count"
    "$@" >/dev/null 2>&1 || status=$?
    printf '%s %s %s\n' "$case_name" "$(wc -l < "$count" | tr -d ' ')" "$status"
}
`;
    const drill = spawnSync("bash", ["-c", HARNESS + subject.drill], {
        encoding: "utf8",
        env: { ...process.env, SCRIPT: join(root, subject.script) },
    });
    if (drill.error !== undefined || drill.status !== 0) {
        vouched.push(`${subject.id}: ${compiled.length} pattern(s) checked; the backoff loop was not exercised (no usable bash here)`);
        continue;
    }
    const observed = new Map(
        drill.stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => line.trim().split(/\s+/))
            .map(([name, attempts, status]) => [name, [Number(attempts), Number(status)]]),
    );
    for (const [name, [attempts, status]] of Object.entries(subject.expect)) {
        const got = observed.get(name);
        if (got === undefined) {
            problems.push(`${subject.id}: the drill printed nothing for "${name}" — it did not run`);
        } else if (got[0] !== attempts || got[1] !== status) {
            problems.push(
                `${subject.id}: "${name}" took ${got[0]} attempt(s) and exited ${got[1]}, expected ${attempts} and ${status}`,
            );
        }
    }
    vouched.push(
        `${subject.id}: ${compiled.length} pattern(s), ${subject.rideItOut.length} failure(s) that must ride it out, ` +
            `${subject.failAtOnce.length} that must fail at once, and ${Object.keys(subject.expect).length} loop case(s)`,
    );
}

finish([["a publish retry helper no longer decides the way the releases it was written for needed", problems]], vouched);
