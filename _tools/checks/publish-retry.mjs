#!/usr/bin/env node
/* WHICH FAILED PUBLISH IS WORTH A SECOND ATTEMPT — asserted against the failures that actually killed releases,
 * in both directions, for both of the retry helpers a release runs through.
 *
 *   node _tools/checks/publish-retry.mjs
 *
 * registry-retry.sh and npm-publish-retry.sh are each one decision, and the decision is a list of patterns
 * matched against a tool's output. A pattern that stops matching costs a release:
 *
 *   1.197.0  a 403 from GHCR whose body was a rate limit, not a permission
 *   1.207.0  a blob upload GHCR had accepted and then disowned
 *   1.243.0  a transparency-log entry Rekor refused as a duplicate of its own work, nineteen packages in
 *
 * Every one of those was carried by a retry the moment somebody re-ran the job by hand. A pattern that matches
 * too much costs the opposite — three silent backoffs in front of a broken Dockerfile or an unregistered
 * trusted publisher turn a fast red pipeline into a slow one that reads like an infrastructure flake.
 *
 * THESE USED TO BE SHELL TESTS BESIDE THE SCRIPTS, AND NOTHING RAN THEM. `registry-retry.test.sh` and
 * `npm-publish-retry.test.sh` were both correct, both complete, and both on no list: not the checks manifest,
 * not a workflow, not a package script. That is the exact failure this directory exists to end
 * (manifest.mjs's header), so their corpora moved here — where preflight, the pre-push hook, the turn-ending
 * check and `pnpm checks` all read them.
 *
 * THE PATTERNS ARE READ BACK OUT OF THE SHELL SCRIPTS rather than restated here, the same way affected.mjs
 * reads prepare-image-trees.sh's payload: a second copy of the list is a copy that drifts, and drift in THESE
 * lists is invisible until a release dies. A shape this can no longer read is reported as such, never passed
 * over in silence.
 *
 * POSIX ERE AND JAVASCRIPT AGREE ON EVERYTHING IN THOSE LISTS — alternation, character classes, `+`, `[0-9]` —
 * so the patterns are compiled here as written, case-insensitively, exactly as `grep -Eqi` applies them. One
 * that reached for a dialect feature only one side has would fail to compile below rather than quietly mean
 * something different in the two places.
 *
 * THE BACKOFF LOOPS ARE EXERCISED TOO, through bash, when there is a bash to exercise them with: that a dropped
 * push succeeds on the way back through — and that a publish whose ANSWER was lost is reported as published
 * rather than failed — are the properties the helpers exist for, and neither is visible in the pattern list.
 * Attempted and vouched for less where bash is absent (a Windows pre-push hook), the same trade the
 * vue-templates check makes. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root, trackedFiles } from "./lib/repo.mjs";

/* ── the two subjects ─────────────────────────────────────────────────────────────────────────────────────
 * Each drill prints one line per case, `<case> <attempts> <status>`, and declares what those should be. The
 * delays are set to 0: the gap between attempts is a clock, and this has no reason to wait one out. */

const SUBJECTS = [
    {
        id: "registry-retry",
        script: "_tools/scripts/lib/registry-retry.sh",
        predicate: "registry_retry_transient",
        // Verbatim from the runs that died. A shorter paraphrase would assert less than the release cost to learn.
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
        ],
        // A push GHCR drops once and accepts on the way back through is a GREEN release; a broken build is
        // refused on the first attempt. The attempts are counted ON DISK: registry_retry runs its command as
        // `"$@" | tee`, which puts it in a SUBSHELL, so a counter variable never comes back.
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
            // A conflict the registry does NOT confirm: the landed-probe is what tells this from our own write
            // coming back, so with the registry saying no it must be reported rather than retried.
            ["a conflict the registry does not confirm", "npm error code EPUBLISHCONFLICT\nnpm error You cannot publish over the previously published versions: 1.243.0."],
        ],
        // Three properties the pattern list cannot show: a dropped signature is re-signed and lands; a
        // 4xx about us fails at once; and a publish whose ANSWER was lost is reported as PUBLISHED, because
        // the registry holds the version whatever exit status npm handed back.
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

/* ── the pattern lists, read back out of the scripts ──────────────────────────────────────────────────────── */

const problems = [];
const vouched = [];

for (const subject of SUBJECTS) {
    const source = readFileSync(join(root, subject.script), "utf8");
    // The predicate's body only: the file's other single-quoted text must not be mistaken for a pattern.
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

    /* ── every caller sets pipefail, because the helper is silently useless without it ────────────────────
     * Both helpers judge an attempt by `<command> 2>&1 | tee "$log" || status=$?`, and the status of a
     * PIPELINE is its last command's — tee's, which succeeds whatever the push did. Only `set -o pipefail`
     * makes that status the command's own. So a caller that sources one of these without pipefail gets a
     * retry wrapper that reports SUCCESS for every failure: no retry, no error, a green step over an
     * artifact that never landed. Both scripts state the assumption in a comment ("every caller sets it");
     * this is what keeps it true. */
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

    /* ── and the loop itself, where bash can run it ───────────────────────────────────────────────────────
     * `run` is the harness both drills share: it runs one case, records the retry function's exit status,
     * and prints `<case> <attempts> <status>`. The counter is a file for the subshell reason above. */
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
