import type { CiMainBranch } from "@intentic/sandbox-contract/schemas/ci";
import { mainText } from "./main-known.js";
import { excerptOfJob, type FailedJob, withJob } from "../main-streak.js";

/* What an agent meeting a failure reads of main (`agents ci`): each job failing there with the run, commit and time it
   was read and what its log named, and plain words wherever nothing is known, so silence never reads as a passing main.
   2026-11-17, the shinobi-society audit: agents stashed their work and re-ran main to tell whose a failure was. */

const NOW = Date.parse("2026-11-17T14:10:00Z");
const MINUTE = 60_000;

const job = (runId: number, over: Partial<FailedJob> = {}): FailedJob => ({
    runId,
    jobId: runId * 10,
    name: "verify-core",
    branch: "main",
    workflow: "CI",
    sha: `sha${runId}`,
    ...over,
});

test("a failing main line names each job's run, commit and read time, and the failing tests its log named", () => {
    const failing: CiMainBranch = {
        repo: "web",
        branch: "main",
        state: "failing",
        since: NOW - 300 * MINUTE,
        lastRun: { status: "failed", at: NOW - 12 * MINUTE },
        fixer: "ci-fix-web-41",
        jobs: [
            {
                workflow: "CI",
                job: "verify-core",
                runId: 41,
                sha: "3f2a1b9c8d7e6f5a4b3c",
                readAt: NOW - 12 * MINUTE,
                errors: [
                    "@intentic/sandbox: src/ci/poller.integration.test.ts: (fail) polls once — expect(received).toBe(expected)",
                    "@intentic/web: src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
                ],
            },
            { workflow: "CI", job: "lint", runId: 41, sha: "3f2a1b9c8d7e6f5a4b3c", readAt: NOW - 11 * MINUTE, errors: [] },
            { workflow: "Nightly", job: "e2e", runId: 39, readAt: NOW - 26 * 60 * MINUTE, timedOut: true },
            { workflow: "CI", job: "quick" },
        ],
    };
    expect(mainText([failing], NOW)).toBe(
        [
            "What main's CI is known to fail on, from the runs this sandbox heard (no forge was asked now):",
            "",
            "web · main: FAILING since 2026-11-17 09:10 UTC (5h ago), newest run heard 2026-11-17 13:58 UTC (12m ago); fix agent ci-fix-web-41 has it",
            "  CI / verify-core: run 41 at 3f2a1b9c8d, read 2026-11-17 13:58 UTC (12m ago)",
            "    - @intentic/sandbox: src/ci/poller.integration.test.ts: (fail) polls once — expect(received).toBe(expected)",
            "    - @intentic/web: src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
            "  CI / lint: run 41 at 3f2a1b9c8d, read 2026-11-17 13:59 UTC (11m ago); its log named no failing test or error line, so open the run",
            "  Nightly / e2e (ran out of time): run 39, read 2026-11-16 12:10 UTC (26h ago); what its log named was not kept (the log was unreadable, or it failed before the daemon kept that), so open the run",
            "  CI / quick: no run of it kept, so open the workflow's runs",
            "",
            "A failure matching a job or line above is main's, not yours. One matching nothing here is only not known to be main's: main may have moved since the times above, and a repository not listed is not wired to CI.",
        ].join("\n"),
    );
});

test("nothing known reads as nothing known, never as a passing main", () => {
    expect(mainText([], NOW)).toContain("nothing is known of what fails on main. That is not a passing main.");
    const quiet: CiMainBranch[] = [
        { repo: "api", branch: "main", state: "clear", jobs: [], lastRun: { status: "success", at: NOW - 70 * MINUTE } },
        { repo: "app", branch: "master", state: "clear", jobs: [], lastRun: { status: "failed", at: NOW - 3 * MINUTE } },
        { repo: "docs", state: "unread", jobs: [] },
    ];
    const text = mainText(quiet, NOW);
    expect(text).toContain("api · main: nothing known to fail. The newest run heard on it passed, 2026-11-17 13:00 UTC (1h ago).");
    expect(text).toContain("app · master: nothing known to fail. The newest run heard on it failed, 2026-11-17 14:07 UTC (3m ago), on nothing counted as main's code");
    expect(text).toContain("docs · its main line: no finished run of it heard yet, so nothing is known: a failure there may still be main's.");
});

// 2026-11-19, the shinobi-society audit: "nothing known to fail" while sixteen tests failed on main, in suites CI does not
// run. The sandbox's own runs on clean trees at main commits say so, with the commit, the command, who ran it and when.
test("what the sandbox's own runs at main saw fail is listed after CI's, even where no CI is wired", () => {
    const text = mainText([], NOW, [
        {
            repo: "shinobi",
            sha: "3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
            at: NOW - 40 * MINUTE,
            runs: [
                { command: "cargo test --workspace", at: NOW - 40 * MINUTE, by: "fair-sage-ey2r", failed: 2, passed: 310 },
                { command: "cargo nextest run -p net", at: NOW - 300 * MINUTE, failed: 0, passed: 41 },
            ],
            failed: [
                { test: "engine scenery::tests::grass_density", line: "assertion `left == right` failed (src/scenery.rs:88:9)", at: NOW - 40 * MINUTE },
                { test: "engine scenery::tests::lod", at: NOW - 40 * MINUTE },
            ],
        },
        { repo: "web", sha: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", at: NOW - 5 * MINUTE, runs: [{ command: "bun test", at: NOW - 5 * MINUTE, failed: 0, passed: 12 }], failed: [] },
    ]);
    expect(text).toContain("nothing is known of what fails on main. That is not a passing main.");
    expect(text).toContain(
        [
            "What this sandbox's own test runs saw fail on clean trees at main commits (not CI, so suites CI does not run are here too):",
            "",
            "shinobi · main@3f2a1b9c8d: 2 runs there, newest `cargo test --workspace` by fair-sage-ey2r, 2026-11-17 13:30 UTC (40m ago); failing:",
            "    - engine scenery::tests::grass_density — assertion `left == right` failed (src/scenery.rs:88:9)",
            "    - engine scenery::tests::lod",
            "web · main@0a1b2c3d4e: 1 run there, newest `bun test`, 2026-11-17 14:05 UTC (5m ago); none failed a test.",
        ].join("\n"),
    );
});

test("a failing job keeps the run, commit and time it last failed in, and a bounded few of its log's lines", () => {
    const many = Array.from({ length: 14 }, (_, index) => `(fail) case ${index} ${"x".repeat(300)}`);
    const first = withJob(undefined, job(41), 1_000, { errors: many, ends: [] });
    expect(first.findings[0]).toMatchObject({ source: "CI", text: "verify-core", runId: 41, sha: "sha41", readAt: 1_000 });
    expect(first.findings[0]?.errors).toHaveLength(10);
    expect(first.findings[0]?.errors?.every((line) => line.length <= 240)).toBe(true);

    // What ended a task follows the errors: a job killed for memory printed none.
    const newer = withJob(first, job(42), 2_000, { errors: ["(fail) newer"], ends: ["exit code 137 (SIGKILL)"] });
    expect(newer.findings[0]).toMatchObject({ runId: 42, readAt: 2_000, errors: ["(fail) newer", "exit code 137 (SIGKILL)"] });
    // An older run's news arriving late does not take the newer one's place.
    expect(withJob(newer, job(41), 3_000, { errors: ["(fail) older"], ends: [] }).findings[0]).toMatchObject({ runId: 42, readAt: 2_000 });
    // The same run heard again, its log not read this time, keeps what the first read named.
    expect(withJob(newer, job(42), 4_000).findings[0]).toMatchObject({ runId: 42, readAt: 4_000, errors: ["(fail) newer", "exit code 137 (SIGKILL)"] });
});

test("only a log the forge served names anything for the job", () => {
    expect(excerptOfJob(job(41), "", undefined).named).toBeUndefined();
    expect(excerptOfJob(job(41), "(log unavailable: 404)", undefined).named).toBeUndefined();
    const served = excerptOfJob(job(41), "error: expect(received).toBe(expected)\n(fail) adds [2.00ms]", undefined);
    expect(served.named?.errors).toEqual(["(fail) adds — expect(received).toBe(expected)"]);
    // The fix agent's digest reads the same excerpt either way.
    expect(excerptOfJob(job(41), "(log unavailable: 404)", undefined).excerpt.name).toBe("verify-core");
});
