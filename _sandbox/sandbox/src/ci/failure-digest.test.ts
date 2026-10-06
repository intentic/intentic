import { digestOf, excerptOf, type FailedJobLog, type JobExcerpt } from "./failure-digest.js";

// What a fix agent is handed for a failed run is read out of logs it never sees whole, so each shape a failure takes in
// this repository's jobs is pinned here: the step that failed and nothing around it, each error once with every job
// that printed it, and a budget no run can overflow. The logs below keep GitHub's own framing (a timestamp per line,
// `##[group]Run` opening a step, the exit code closing it), since that framing is what the reading leans on.

const at = (line: string): string => `2026-10-02T21:35:53.2518705Z ${line}`;
const githubLog = (...lines: string[]): string => lines.map(at).join("\n");

// A step as the runner prints it: its command as a group, the env block it echoes, what it printed, and its exit code.
const step = (command: string, printed: readonly string[], exitCode?: number): string[] => [
    `##[group]Run ${command}`,
    command,
    "shell: sh -e {0}",
    "env:",
    "  PNPM_STORE: /ci-cache/pnpm-store",
    "##[endgroup]",
    ...printed,
    ...(exitCode === undefined ? [] : [`##[error]Process completed with exit code ${exitCode}.`]),
];

const job = (name: string, log: string, steps: readonly string[] = []): FailedJobLog => ({ name, log, steps, url: `https://github.com/acme/web/actions/runs/7/job/${name.length}` });

const typecheckFailure = [
    "##[group]@intentic/web:typecheck",
    "cache miss, executing 503a488bea2dc904",
    "##[endgroup]",
    "@intentic/demo:typecheck",
    "$ vue-tsc --noEmit -p tsconfig.json",
    "src/unserved.ts(345,3): error TS1360: Type '{ a: string }' does not satisfy the expected type.",
    "  Type '{ a: string }' is missing the following properties",
    "[ELIFECYCLE] Command failed with exit code 2.",
    "@intentic/demo#typecheck:  WARNING  command finished with error, but continuing...",
    "##[error]command (/__w/web/web/_site/demo) /usr/local/share/pnpm/bin/pnpm run typecheck exited (2)",
    "",
    " Tasks:    75 successful, 76 total",
    "Failed:    @intentic/demo#typecheck",
];

test("only the failed step is read: its errors, and its own last lines without the env block or the passing steps", () => {
    const excerpt = excerptOf(
        job(
            "verify-core / verify",
            githubLog(
                ...step("pnpm install --frozen-lockfile", ["Done in 4s", "error TS9999: printed by a step that passed"]),
                ...step("pnpm turbo run typecheck $FILTERS", typecheckFailure, 2),
                "Post job cleanup.",
                "[command]/usr/bin/git version",
            ),
            ["Run pnpm turbo run typecheck $FILTERS"],
        ),
    );
    expect(excerpt.errors).toEqual([
        "@intentic/demo: src/unserved.ts(345,3): error TS1360: Type '{ a: string }' does not satisfy the expected type.",
        "turbo: failed @intentic/demo#typecheck",
    ]);
    expect(excerpt.tail.startsWith("$ pnpm turbo run typecheck $FILTERS\n")).toBe(true);
    expect(excerpt.tail).toContain("Failed:    @intentic/demo#typecheck");
    expect(excerpt.tail).not.toContain("PNPM_STORE");
    expect(excerpt.tail).not.toContain("Done in 4s");
    expect(excerpt.tail).not.toContain("Post job cleanup.");
    expect(excerpt.tail).not.toContain("2026-10-02T");
});

test("a failing test is named with its file and its message once, though bun says it twice and passing tests print errors too", () => {
    const excerpt = excerptOf(
        job(
            "verify-clocks (Pacific/Niue)",
            githubLog(
                ...step(
                    "pnpm turbo run test --filter=@intentic/sandbox",
                    [
                        "@intentic/sandbox:test",
                        "##[group]src/privacy/tests/image-mask.integration.test.ts:",
                        "error: boom",
                        "(pass) a warm-up that logs an error and passes [0.10ms]",
                        "(pass) a test named after error TS2307: Cannot find module 'vue' [0.20ms]",
                        "53 |         expect(text).toMatch(/NATI[O0]NAL_ID/u);",
                        "error: expect(received).toMatch(expected)",
                        "      at <anonymous> (/__w/web/web/_sandbox/sandbox/src/privacy/tests/image-mask.integration.test.ts:53:22)",
                        "(fail) a masked image read again holds the token [11068.40ms]",
                        "##[endgroup]",
                        " 1 fail",
                        "(fail) a masked image read again holds the token [11068.40ms]",
                    ],
                    1,
                ),
            ),
        ),
    );
    expect(excerpt.errors).toEqual([
        "@intentic/sandbox: src/privacy/tests/image-mask.integration.test.ts: (fail) a masked image read again holds the token — expect(received).toMatch(expected)",
    ]);
});

test("a failed check keeps its findings under it, a few at most, and the push check's verdict line too", () => {
    const findings = Array.from({ length: 9 }, (_, index) => `  - _editor/web/src/lib/file${index}.ts:13  catch returns a literal and drops the error`);
    const excerpt = excerptOf(
        job(
            "quick",
            githubLog(
                ...step(
                    "node _tools/scripts/verify/verify-push.mjs --base $BASE",
                    [
                        "verify-push: measuring ae6ffd415..f9f257a37",
                        "",
                        "✗ silent-catch (silent-catch.mjs)",
                        "9 problem(s) this range introduces",
                        ...findings,
                        "verify-push: tidiness failed",
                        "  ✗ tidiness  1 tidy check(s) this range breaks: silent-catch · node _tools/checks/run.mjs --only silent-catch",
                    ],
                    1,
                ),
            ),
        ),
    );
    expect(excerpt.errors).toEqual([
        [
            "✗ silent-catch (silent-catch.mjs)",
            ...Array.from({ length: 6 }, (_, index) => `    - _editor/web/src/lib/file${index}.ts:13 catch returns a literal and drops the error`),
        ].join("\n"),
        "✗ tidiness 1 tidy check(s) this range breaks: silent-catch · node _tools/checks/run.mjs --only silent-catch",
    ]);
});

test("a compiler's error carries the place it names, and a formatter's and a test runner's failures are said in a line", () => {
    const excerpt = excerptOf(
        job(
            "netd-check",
            githubLog(
                ...step("cargo fmt --all --check", ["Diff in /__w/web/web/_sandbox/netd/src/main.rs at line 12:", "-fn main(){", "+fn main() {"], 1),
                ...step(
                    "cargo clippy --all-targets --locked -- -D warnings",
                    ["error: unused variable: `port`", "  --> crates/tunnel/src/lib.rs:41:9", "   |", "error: could not compile `tunnel`"],
                    101,
                ),
                ...step("cargo test --locked", ["test frames::round_trip ... FAILED", "failures:"], 101),
            ),
        ),
    );
    expect(excerpt.errors).toEqual([
        "rustfmt: _sandbox/netd/src/main.rs differs at line 12",
        "error: unused variable: `port` --> crates/tunnel/src/lib.rs:41:9",
        "test frames::round_trip FAILED",
    ]);
});

test("a failed step that prints none of the known shapes still gives its last error-sounding lines", () => {
    const excerpt = excerptOf(
        job("desktop-verify", githubLog(...step("bash verify-desktop-install.sh", ["installing the .deb", "dpkg: error processing package intentic (--install):", "done"], 1))),
    );
    expect(excerpt.errors).toEqual(["dpkg: error processing package intentic (--install):"]);
});

test("a trace that marks no steps (GitLab) is read whole, and its tail is its end", () => {
    const excerpt = excerptOf(job("test", ["$ pnpm test", "FAIL src/a.test.ts", "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @acme/web@1.0.0 test: `vitest`", "the end"].join("\n")));
    expect(excerpt.errors).toEqual(["FAIL src/a.test.ts", "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @acme/web@1.0.0 test: `vitest`"]);
    expect(excerpt.tail.endsWith("the end")).toBe(true);
});

test("one cause printed by several jobs is listed once, naming every job that printed it", () => {
    const failing = githubLog(...step("pnpm turbo run typecheck $FILTERS", typecheckFailure, 2));
    const digest = digestOf([excerptOf(job("verify-core / verify", failing)), excerptOf(job("verify-site / verify", failing))]);
    expect(digest).toContain(
        "- [verify-core / verify, verify-site / verify] @intentic/demo: src/unserved.ts(345,3): error TS1360: Type '{ a: string }' does not satisfy the expected type.",
    );
    expect(digest.match(/error TS1360/g)?.length).toBe(1 + 2);
    expect(digest.startsWith("2 failed jobs:\n- verify-core / verify (https://")).toBe(true);
});

test("however long the logs, the digest stays within its budget and every job keeps a share of its own words", () => {
    const loud = (name: string): JobExcerpt => ({
        name,
        steps: ["Run pnpm turbo run build test"],
        errors: Array.from({ length: 40 }, (_, index) => `${name}: src/file${index}.ts(1,1): error TS2322: ${"x".repeat(200)}`),
        tail: Array.from({ length: 400 }, (_, index) => `${name} line ${index}`).join("\n"),
    });
    const excerpts = ["verify-core / verify", "verify-site / verify", "verify-platform / verify", "desktop-check"].map(loud);
    const digest = digestOf(excerpts, 12_000);
    expect(digest.length).toBeLessThanOrEqual(12_000);
    for (const { name } of excerpts) {
        expect(digest).toContain(`--- ${name}: the failed steps' last lines ---\n…\n`);
        expect(digest).toContain(`${name} line 399`);
    }
    expect(digest).toMatch(/… and \d+ more, in the jobs' logs/);
    expect(digestOf([])).toBe("");
});
