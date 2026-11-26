import { localMainText } from "./local-main.js";

// What `agents ci` says below main's CI half (the pipelines extension's): the sandbox's own test runs at main commits, in
// the core's words (GET /ci/main/local). Moved here with the words on 2026-11-26.

const NOW = Date.parse("2026-11-17T14:10:00Z");
const MINUTE = 60_000;

test("nothing recorded is said as nothing", () => {
    expect(localMainText([], NOW)).toBe("");
});

// 2026-11-19, the shinobi-society audit: "nothing known to fail" while sixteen tests failed on main, in suites CI does not
// run. The sandbox's own runs on clean trees at main commits say so, with the commit, the command, who ran it and when.
test("what the sandbox's own runs at main saw fail is said with the commit, the command, who ran it and when", () => {
    const text = localMainText([
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
    ], NOW);
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

