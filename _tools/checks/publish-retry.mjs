#!/usr/bin/env node
// Checks registry-retry.sh, npm-publish-retry.sh, image-pull.sh and github.sh: each is a pattern list deciding which
// failure a release rides out, asserted against failures that actually killed one, in both directions. Patterns are read
// back out of the scripts, compiled as POSIX ERE case-insensitively; the retry loop is drilled through bash when available.
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
            [
                "a blob commit the registry never answered (killed images-platform on 213a4477)",
                'failed commit on ref "layer-sha256:e7dd12f8e8a7c17dbb7d2f4da15c9d6c14a110addab135148bd6992972ef54df": failed to do request: Put "https://ghcr.io/v2/intentic/ingress/blobs/upload/4.c1d01de0-4ff9-4e47-aa8b-3326289e31d3?digest=sha256%3Ae7dd12f8e8a7c17dbb7d2f4da15c9d6c14a110addab135148bd6992972ef54df": net/http: timeout awaiting response headers',
            ],
            [
                "the same unanswered request on the client's own deadline",
                'failed to do request: Put "https://ghcr.io/v2/intentic/api/manifests/latest": net/http: request canceled (Client.Timeout exceeded while awaiting headers)',
            ],
            [
                "an oauth token fetch throttled by GHCR (killed 1.308.1)",
                "ERROR: copy sha256:7f32cfa3e409a3cddb2fa465e304285b1200948d3074dc6588058eae4b59af8a from ghcr.io/intentic/sandbox:1.308.1-arm64 to ghcr.io/intentic/sandbox:stable: httpReadSeeker: failed open: failed to authorize: failed to fetch oauth token: unexpected status from GET request to https://ghcr.io/token?scope=repository%3Aintentic%2Fsandbox%3Apull&service=ghcr.io: 403 Forbidden",
            ],
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
            // Turbo tears down the sibling tasks of one that failed, and their cancellation reads like a timeout at a
            // glance. Retrying one waits out a clock that has already stopped, three times, for a build nobody wants.
            ["a sibling task torn down", "ERROR: failed to build: failed to solve: Canceled: context canceled"],
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
    {
        id: "image-pull",
        script: "_tools/scripts/lib/image-pull.sh",
        predicate: "image_pull_unpack_fault",
        // The unpack, which is the half of a pull the registry has no part in: this daemon's own store losing content
        // mid-extraction, with every byte already downloaded.
        rideItOut: [
            [
                "the snapshot chain that killed 1.285.0",
                'failed to prepare extraction snapshot "extract-867389931-0Kfz sha256:278bf3cda0236f4a22b831e080996f5133d1fffd0b2ab161f274ffffee5f5a60": NotFound: parent snapshot sha256:ceeb23b44c468b37b32588cfb2d4eb623eece649685b8d0e535b2b10a1dced5f does not exist: not found',
            ],
            ["the same race with no parent to name", "failed to prepare extraction snapshot: content sha256:278bf3cda023: not found"],
            [
                "a blob collected out from under the unpack",
                "failed to extract layer sha256:278bf3cda023: failed to get reader from content store: content digest sha256:ceeb23b44c46: not found",
            ],
        ],
        // A pull is not re-run for anything re-running cannot fix: a disk with no room for 5 GB stays that way, and
        // every verdict the registry reaches is registry-retry.sh's to judge one layer in.
        failAtOnce: [
            ["a full disk", "failed to register layer: write /var/lib/docker/overlay2/2f0c/merged/opt/sandbox/node_modules/a: no space left on device"],
            [
                "a tag that is not there",
                'Error response from daemon: failed to resolve reference "ghcr.io/intentic/sandbox:no-such-tag": ghcr.io/intentic/sandbox:no-such-tag: not found',
            ],
            ["no login", 'Error response from daemon: Head "https://ghcr.io/v2/intentic/sandbox/manifests/1.285.0-amd64": unauthorized'],
            [
                "a throttled registry, which is the other helper's to ride out",
                'failed to resolve reference: denied: permission_denied: 403 "Forbidden" You have exceeded a secondary rate limit.',
            ],
        ],
        // Three properties the pattern list alone can't show: a lost snapshot is dropped and re-pulled until it lands, a
        // store that keeps losing it gives up rather than pulling 5 GB forever, and a registry verdict is not re-asked.
        drill: String.raw`
export REGISTRY_RETRY_ATTEMPTS=1 IMAGE_PULL_ATTEMPTS=3 IMAGE_PULL_DELAY=0
LOST='failed to prepare extraction snapshot "extract-867389931-0Kfz sha256:278bf3cda023": NotFound: parent snapshot sha256:ceeb23b44c46 does not exist: not found'
MISSING='Error response from daemon: failed to resolve reference "ghcr.io/intentic/sandbox:no-such-tag": ghcr.io/intentic/sandbox:no-such-tag: not found'

# The stub docker: "pull" prints the failure under test and counts the attempt, "image rm" is the drop between
# attempts, which always succeeds because there may be nothing left to drop.
docker() {
    case "$1" in
        pull)
            echo x >> "$count"
            [ "$FLAKY" = yes ] && [ "$(wc -l < "$count")" -ge 2 ] && { echo 'Status: Downloaded newer image'; return 0; }
            printf '%s\n' "$OUTPUT"
            return 1 ;;
        image) return 0 ;;
    esac
}

FLAKY=yes OUTPUT="$LOST"    run cleared     image_pull ghcr.io/intentic/sandbox:1.285.0-amd64
FLAKY=no  OUTPUT="$LOST"    run store-gone  image_pull ghcr.io/intentic/sandbox:1.285.0-amd64
FLAKY=no  OUTPUT="$MISSING" run missing-tag image_pull ghcr.io/intentic/sandbox:no-such-tag
`,
        expect: { cleared: [2, 0], "store-gone": [3, 1], "missing-tag": [1, 1] },
    },
    {
        id: "github-upload",
        script: "_tools/scripts/lib/github.sh",
        predicate: "gh_upload_transient",
        // uploads.github.com under a nineteen-asset burst, in curl's words — the only words there are, since --fail
        // throws the body away and answers 22 for every HTTP verdict alike.
        rideItOut: [
            ["the 500s that killed v1.289.0", "curl: (22) The requested URL returned error: 500"],
            ["the 504s from that same publish", "curl: (22) The requested URL returned error: 504 Gateway Timeout"],
            ["an endpoint asking us to slow down", "curl: (22) The requested URL returned error: 429"],
            ["a hundred megabytes cut short mid-PUT", "curl: (18) transfer closed with 41582592 bytes remaining to read"],
            ["the connection dropped under the upload", "curl: (56) Recv failure: Connection reset by peer"],
            ["an upload that went quiet", "curl: (28) Operation timed out after 300000 milliseconds with 0 bytes received"],
            ["the endpoint answering nothing at all", "curl: (52) Empty reply from server"],
            ["the HTTP/2 stream torn down", "curl: (92) HTTP/2 stream 5 was not closed cleanly: INTERNAL_ERROR (err 2)"],
        ],
        // Every verdict GitHub reaches ABOUT US. The 422 is here because the pattern list must not be what retries it:
        // a duplicate name is settled by asking what the release holds, not by sending the bytes again and again.
        failAtOnce: [
            ["a token GitHub does not know", "curl: (22) The requested URL returned error: 401"],
            ["a token without contents:write", "curl: (22) The requested URL returned error: 403"],
            ["a release id that is not there", "curl: (22) The requested URL returned error: 404"],
            ["a name the release already holds", "curl: (22) The requested URL returned error: 422"],
            ["an artifact nobody built", "curl: (26) Failed to open/read local data from file/application"],
        ],
        // Five properties the pattern list alone can't show: a dropped upload lands on the retry, a verdict about us
        // fails at once, a lost answer is reported as attached, a half-written row is cleared and the name re-used, and
        // a row that will not clear gives up rather than uploading forever.
        drill: String.raw`
export GH_UPLOAD_ATTEMPTS=3 GH_UPLOAD_DELAY=0
REFUSED='curl: (22) The requested URL returned error: 500'
FORBIDDEN='curl: (22) The requested URL returned error: 403'
DUPLICATE='curl: (22) The requested URL returned error: 422'

# The stub upload: prints the refusal under test where curl's own stderr goes, and counts the attempt.
gh_api() {
    echo x >> "$count"
    [ "$FLAKY" = yes ] && [ "$(wc -l < "$count")" -ge 2 ] && return 0
    printf '%s\n' "$OUTPUT" >&2
    return 22
}
# What the release holds under that name afterwards: nothing, the finished asset, or a half-written row.
gh_asset_by_name() { printf '%s' "$HELD"; }
gh_delete_asset() { return 0; }

HELD=''           FLAKY=yes OUTPUT="$REFUSED"   run flaky       gh_upload_asset intentic/intentic 42 /dev/null asset.bin
HELD=''           FLAKY=no  OUTPUT="$FORBIDDEN" run forbidden   gh_upload_asset intentic/intentic 42 /dev/null asset.bin
HELD='7 uploaded' FLAKY=no  OUTPUT="$DUPLICATE" run lost-answer gh_upload_asset intentic/intentic 42 /dev/null asset.bin
HELD='7 starter'  FLAKY=yes OUTPUT="$DUPLICATE" run wreckage    gh_upload_asset intentic/intentic 42 /dev/null asset.bin
HELD='7 starter'  FLAKY=no  OUTPUT="$DUPLICATE" run wreck-stays gh_upload_asset intentic/intentic 42 /dev/null asset.bin
`,
        expect: { flaky: [2, 0], forbidden: [1, 22], "lost-answer": [1, 0], wreckage: [2, 0], "wreck-stays": [3, 22] },
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

finish([["a retry helper no longer decides the way the releases it was written for needed", problems]], vouched);
