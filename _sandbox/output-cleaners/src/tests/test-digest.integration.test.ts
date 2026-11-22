import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterRun } from "../agent-output-filter.mjs";
import { testDigest } from "../test-digest.mjs";
import { baselinesAt, mainBaselines, recordRun } from "../test-outcomes.mjs";

// The digest a failed test run ends with, against real repositories: the first run on a clean tree at a main commit is
// that commit's baseline, and a later run in a worktree forked from it labels each failure against it. 2026-11-19, the
// shinobi-society audit: "already fails on main" was argued by hand in 19 conversations.

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "test-digest-"));
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const git = (cwd: string, ...args: string[]): string => {
    const ran = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
    if (ran.status !== 0) {
        throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);
    }
    return ran.stdout.trim();
};

// A repository on `main` with one commit, its checkout, and an empty record.
const repository = () => {
    const root = tempDir();
    const repo = join(root, "game");
    git(root, "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "lib.rs"), "fn main() {}\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first");
    return { repo, record: join(root, "record"), main: git(repo, "rev-parse", "HEAD") };
};

// A conversation's worktree forked from main, with an edit in it.
const worktree = (repo: string, name: string): string => {
    const dir = join(tempDir(), name);
    git(repo, "worktree", "add", "-q", "-b", `agent/${name}`, dir);
    writeFileSync(join(dir, "lib.rs"), "fn main() { changed() }\n");
    return dir;
};

// cargo test's output with these outcomes in one crate.
const cargo = (outcomes: Record<string, "ok" | "FAILED">): string => {
    const names = Object.keys(outcomes);
    const failed = names.filter((name) => outcomes[name] === "FAILED");
    return [
        "     Running unittests src/lib.rs (target/debug/deps/game-0123456789abcdef)",
        "",
        `running ${names.length} tests`,
        ...names.map((name) => `test ${name} ... ${outcomes[name]}`),
        "",
        "failures:",
        "",
        ...failed.flatMap((name) => [`---- ${name} stdout ----`, "", `thread '${name}' panicked at src/lib.rs:7:5:`, `${name} broke`, ""]),
        `test result: ${failed.length > 0 ? "FAILED" : "ok"}. ${names.length - failed.length} passed; ${failed.length} failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`,
    ].join("\n");
};

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-19T10:00:00Z");
const short = (sha: string): string => sha.slice(0, 9);

test("a run on a clean tree at main is recorded as that commit's baseline, and says its failures are main's", () => {
    const { repo, record, main } = repository();
    const digest = testDigest(cargo({ "scenery::a": "FAILED", "scenery::b": "ok" }).split("\n"), { command: "cargo test", cwd: repo, dir: record, by: "conv-1", now: T0 });
    expect(digest).toBe(
        [
            `--- tests: 1 failed, 1 passed (cargo) · ran on a clean tree at main@${short(main)}: recorded as its baseline, so these fail at main itself`,
            "✗ game scenery::a: scenery::a broke (src/lib.rs:7:5)",
        ].join("\n"),
    );
    expect(readdirSync(record).filter((name) => name.includes("-b-"))).toHaveLength(1);
    expect(mainBaselines(record)).toEqual([
        {
            repo: "game",
            sha: main,
            at: T0,
            runs: [{ command: "cargo test", at: T0, by: "conv-1", counts: { passed: 1, failed: 1, ignored: 0 } }],
            failed: [{ test: "game scenery::a", line: "scenery::a broke (src/lib.rs:7:5)", at: T0 }],
        },
    ]);
});

// A machine at rest and one under the load cider-644m's ten "new" failures ran at (11-16 on 16 cores).
const CALM = { one: 2.1, cores: 16 };
const LOADED = { one: 14.3, cores: 16 };

test("a worktree's failures are each labelled against the baseline at its fork point, and only a pass there makes one new", () => {
    const { repo, record, main } = repository();
    testDigest(cargo({ "scenery::a": "FAILED", "scenery::b": "ok" }).split("\n"), { command: "cargo test", cwd: repo, dir: record, now: T0, load: CALM });
    const work = worktree(repo, "fox");
    const digest = testDigest(cargo({ "scenery::a": "FAILED", "scenery::b": "FAILED", "net::c": "FAILED" }).split("\n"), {
        command: "cargo test --no-fail-fast",
        cwd: work,
        dir: record,
        now: T0 + 90 * MINUTE,
        hasBase: true,
        load: CALM,
    });
    expect(digest).toBe(
        [
            `--- tests: 3 failed, 0 passed (cargo) · against main@${short(main)} (your fork point)`,
            // What is the change's own comes first: passing at main, then never run there, then main's own.
            `✗ game scenery::b: scenery::b broke (src/lib.rs:7:5) — new: passes at main@${short(main)}`,
            // 2026-11-22, cider-644m: a test the baseline never ran was called new.
            `✗ game net::c: net::c broke (src/lib.rs:7:5) — not run at main@${short(main)}: no recorded run there includes it`,
            `✗ game scenery::a: scenery::a broke (src/lib.rs:7:5) — also fails at main@${short(main)} (seen 2h ago)`,
            `--- 1 of these was not run at main@${short(main)}; \`base run cargo test --no-fail-fast\` runs this there and records it.`,
        ].join("\n"),
    );
    // The worktree's run is kept as a work run, never as a baseline.
    expect(readdirSync(record).filter((name) => name.includes("-w-"))).toHaveLength(1);
});

test("past fifteen failures the rest are counted by verdict: new first, then not run at main, then main's own", () => {
    const { repo, record, main } = repository();
    const named = (prefix: string, count: number, outcome: "ok" | "FAILED") =>
        Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}::t${index}`, outcome]));
    const old = named("old", 20, "FAILED");
    testDigest(cargo({ ...old, ...named("calm", 14, "ok") }).split("\n"), { command: "cargo test", cwd: repo, dir: record, now: T0, load: CALM });
    const work = worktree(repo, "ant");
    const failing = { ...old, ...named("calm", 14, "FAILED"), ...named("fresh", 3, "FAILED") };
    const lines = testDigest(cargo(failing).split("\n"), { command: "cargo test", cwd: work, dir: record, now: T0, hasBase: true, load: CALM }).split("\n");
    expect(lines[1]).toBe(`✗ game calm::t0: calm::t0 broke (src/lib.rs:7:5) — new: passes at main@${short(main)}`);
    expect(lines[15]).toBe(`✗ game fresh::t0: fresh::t0 broke (src/lib.rs:7:5) — not run at main@${short(main)}: no recorded run there includes it`);
    expect(lines.slice(-2)).toEqual([
        `… +22 more failing: 0 new, 2 not run at main@${short(main)}, 20 also failing at main@${short(main)} (each in the full output)`,
        `--- 3 of these were not run at main@${short(main)}; \`base run cargo test\` runs this there and records it.`,
    ]);
});

test("a new failure on a loaded machine says the baseline passed it at much lower load", () => {
    const { repo, record, main } = repository();
    testDigest(cargo({ "fleet::spawns_servers": "ok" }).split("\n"), { command: "cargo test", cwd: repo, dir: record, now: T0, load: CALM });
    const work = worktree(repo, "emu");
    const failing = cargo({ "fleet::spawns_servers": "FAILED" }).split("\n");
    const at = (load: { one: number; cores: number }) => testDigest(failing, { command: "cargo test", cwd: work, dir: record, now: T0, load }).split("\n")[1];
    expect(at(LOADED)).toBe(
        `✗ game fleet::spawns_servers: fleet::spawns_servers broke (src/lib.rs:7:5) — new: passed at main@${short(main)} at load 2.1/16; this run at 14.3/16, so a timing-sensitive test may fail from load alone: \`base run\` it now to compare`,
    );
    // Under 0.75 per core, or under twice the baseline's, the load is not named.
    expect(at({ one: 11, cores: 16 })).toContain(`— new: passes at main@${short(main)}`);
    expect(at({ one: 14.3, cores: 32 })).toContain(`— new: passes at main@${short(main)}`);
    // The run recorded its load, and a run recorded before runs kept one still reads, with none to compare.
    expect(baselinesAt(record, main)[0]?.load).toEqual(CALM);
    const { repo: older, record: olderRecord } = repository();
    recordRun(olderRecord, {
        repo: "game",
        sha: git(older, "rev-parse", "HEAD"),
        tree: "clean",
        baseline: true,
        command: "cargo test",
        runners: ["cargo"],
        partial: false,
        counts: { passed: 1, failed: 0, ignored: 0 },
        tests: [{ id: "game fleet::spawns_servers", suite: "game", name: "fleet::spawns_servers", outcome: "pass" }],
    });
    expect(baselinesAt(olderRecord, git(older, "rev-parse", "HEAD"))[0]?.load).toBeUndefined();
    const olderWork = worktree(older, "gnu");
    expect(testDigest(failing, { command: "cargo test", cwd: olderWork, dir: olderRecord, now: T0, load: LOADED })).toContain("— new: passes at main@");
});

test("a grep that dropped the binary's line still matches main's failure by name", () => {
    const { repo, record, main } = repository();
    testDigest(cargo({ "scenery::a": "FAILED" }).split("\n"), { command: "cargo test", cwd: repo, dir: record, now: T0 });
    const work = worktree(repo, "owl");
    const digest = testDigest(["test scenery::a ... FAILED"], { command: "cargo test 2>&1 | grep FAILED", cwd: work, dir: record, now: T0 });
    expect(digest).toContain(`✗ scenery::a — also fails at main@${short(main)} (seen 0m ago)`);
});

test("with no baseline it names the one command that makes one, `base run` where it is installed", () => {
    const { repo, record, main } = repository();
    const work = worktree(repo, "elk");
    const lines = cargo({ "scenery::a": "FAILED" }).split("\n");
    const withBase = testDigest(lines, { command: "cargo test", cwd: work, dir: record, now: T0, hasBase: true });
    expect(withBase).toContain(`--- no baseline: nothing is recorded of these tests at main@${short(main)} (your fork point); \`base run cargo test\` runs this there and records it`);
    const without = testDigest(lines, { command: "cargo test", cwd: work, dir: record, now: T0, hasBase: false });
    expect(without).toContain(`run \`cargo test\` once in a clean checkout of that commit (\`git worktree add --detach <dir> ${short(main)}\`) and it is recorded`);
    // The command it names is the test command itself: no leading `cd`, no filter after it, since a baseline wants every line.
    const piped = testDigest(lines, { command: "cd crates && cargo test -p engine 2>&1 | grep -E 'FAILED|panicked'", cwd: work, dir: record, now: T0, hasBase: true });
    expect(piped).toContain("`base run cargo test -p engine` runs this there");
    // Where nothing is recorded (no logs directory), it promises no recording.
    expect(testDigest(lines, { command: "cargo test", cwd: work, now: T0, hasBase: true })).not.toContain("no baseline");
});

// 2026-11-22, the shinobi-society audit: lines like these were offered as `base run '…'` whole, edits included, or cut
// at their first `| head` before the test command was reached.
test("the command it names is the line's test command alone, from the directory its `cd`s led to", () => {
    const { repo, record } = repository();
    const work = worktree(repo, "gnat");
    mkdirSync(join(work, "integra"));
    const lines = cargo({ "scenery::a": "FAILED" }).split("\n");
    const named = (command: string, hasBase = true): string =>
        testDigest(lines, { command, cwd: work, dir: record, now: T0, hasBase }).split("\n").at(-1)?.replace(/^.*?; /, "").replace(/, and every later run.*$/, "") ?? "";
    // Every `cd` before it is followed; only its own filters and redirections go; its env and `timeout` stay.
    expect(
        named(
            "sed -i '/^use shinobi_society::skills::catalog;$/d' footprint.rs && cd integra && free -g | head -3 && RUST_BACKTRACE=1 timeout 600 cargo test -p server --no-fail-fast 2>&1 | tail -40",
        ),
    ).toBe(`\`cd ${join(work, "integra")} && RUST_BACKTRACE=1 base run timeout 600 cargo test -p server --no-fail-fast\` runs this there and records it`);
    expect(named("f=crates/audio/src/bank.rs && perl -0pi -e 's/a/b/' $f && cargo test -p audio > /tmp/out.txt 2>&1; tail /tmp/out.txt")).toBe(
        "`base run cargo test -p audio` runs this there and records it",
    );
    expect(named("export RUST_LOG=debug\ncargo test -p audio -- 'fleet::a b' &> log.txt")).toBe(
        "`RUST_LOG=debug base run cargo test -p audio -- 'fleet::a b'` runs this there and records it",
    );
    expect(named("time -p cargo test -p audio 2>&1 | tail -5", false)).toContain("run `cargo test -p audio` once in a clean checkout");
    // A heredoc, or two test commands, and it names none rather than one that would edit the base or run half the line.
    const alone = "run the test command alone through `base run` to run it there and record it";
    expect(named("cat >> crates/audio/tests/director.rs <<'EOF'\n#[test]\nfn plays() {}\nEOF\ncargo test -p audio")).toBe(alone);
    expect(named("cargo test -p audio; cargo test -p server")).toBe(alone);
    expect(named("cargo test -p audio", false)).toContain("run `cargo test -p audio` once");
});

test("`base run` from a worktree with changes is recorded at the fork point, as a baseline", () => {
    const { repo, record, main } = repository();
    const work = worktree(repo, "yak");
    git(work, "commit", "-q", "-am", "the agent's own commit");
    const failing = cargo({ "scenery::a": "FAILED" }).split("\n");
    const digest = testDigest(failing, { command: "base run cargo test", cwd: work, dir: record, now: T0 });
    expect(digest).toContain(`ran on a clean tree at main@${short(main)}: recorded as its baseline`);
    // After a `cd`, and after an edit (which a leading-`cd` reading filed as this checkout's run), it is still `base run`'s.
    mkdirSync(join(work, "crates"));
    for (const command of ["cd crates && base run cargo test", "sed -i 's/a/b/' lib.rs && RUST_LOG=1 base run cargo test 2>&1 | tail"]) {
        expect(testDigest(failing, { command, cwd: work, dir: record, now: T0 })).toContain(`ran on a clean tree at main@${short(main)}: recorded as its baseline`);
    }
    expect(readdirSync(record).filter((name) => name.startsWith(`${main.slice(0, 12)}-b-`))).toHaveLength(3);
    // A line that ran the tests both at the base and here holds two runs' output: neither record can have it.
    testDigest(failing, { command: "base run cargo test; cargo test", cwd: work, dir: record, now: T0 });
    expect(readdirSync(record)).toHaveLength(3);
});

test("a baseline a few commits from the fork point stands in for it, and says how far", () => {
    const { repo, record } = repository();
    const older = git(repo, "rev-parse", "HEAD");
    testDigest(cargo({ "scenery::a": "FAILED" }).split("\n"), { command: "cargo test", cwd: repo, dir: record, now: T0 });
    writeFileSync(join(repo, "lib.rs"), "fn main() { newer() }\n");
    git(repo, "commit", "-q", "-am", "main moves on");
    const work = worktree(repo, "cat");
    const digest = testDigest(cargo({ "scenery::a": "FAILED" }).split("\n"), { command: "cargo test", cwd: work, dir: record, now: T0 });
    expect(digest).toContain(`against main@${short(older)} (1 commit before your fork point)`);
    expect(digest).toContain(`also fails at main@${short(older)}`);
});

test("a run that passes adds nothing to the output, and the record keeps its bounds by age", () => {
    const { repo, record } = repository();
    const stale = recordRun(
        record,
        {
            repo: "game",
            sha: git(repo, "rev-parse", "HEAD"),
            tree: "clean",
            baseline: true,
            command: "cargo test",
            runners: ["cargo"],
            partial: false,
            counts: { passed: 1, failed: 0, ignored: 0 },
            tests: [],
        },
        T0 - 30 * 24 * 60 * MINUTE,
    );
    expect(stale).toEqual(expect.any(String));
    expect(testDigest(cargo({ "scenery::a": "ok" }).split("\n"), { command: "cargo test", cwd: repo, dir: record, now: T0 })).toBe("");
    // The passing run is still recorded, and the month-old one is gone.
    expect(readdirSync(record)).toHaveLength(1);
});

test("past its bounds the record drops the oldest work runs first, and keeps baselines", () => {
    const { record, main } = repository();
    const run = (baseline: boolean) => ({
        repo: "game",
        sha: main,
        tree: baseline ? "clean" : "0123456789ab",
        baseline,
        command: "cargo test",
        runners: ["cargo"],
        partial: false,
        counts: { passed: 0, failed: 0, ignored: 0 },
        tests: [],
    });
    const keep = { files: 3, bytes: 1_000_000, ms: 24 * 60 * MINUTE };
    const order = [true, false, true, false, false];
    order.forEach((baseline, index) => recordRun(record, run(baseline), T0 + index * MINUTE, keep));
    const kept = readdirSync(record).map((name) => name.split("-")[1]);
    expect(kept.toSorted()).toEqual(["b", "b", "w"]);
    // The work run kept is the newest one.
    expect(readdirSync(record).filter((name) => name.includes("-w-"))).toEqual([expect.stringContaining(`-w-${(T0 + 4 * MINUTE).toString(36)}-`)]);
});

test("the filter ends a failed test run's output with its digest, ledgered as `tests`, and leaves other commands alone", () => {
    const { repo, record } = repository();
    const raw = `${cargo({ "scenery::a": "FAILED", "scenery::b": "ok" })}\n`;
    const outcomes = { dir: record, cwd: repo };
    const { out, stages } = filterRun(raw, { command: "cargo test", exitCode: "101", outcomes, now: () => T0 });
    expect(out.startsWith(raw.split("\n")[0] ?? "")).toBe(true);
    expect(out.trimEnd().split("\n").at(-1)).toBe("✗ game scenery::a: scenery::a broke (src/lib.rs:7:5)");
    // Every byte is accounted for: raw minus what each stage saved is what was emitted.
    expect(raw.length - stages.reduce((sum, stage) => sum + stage.saved, 0)).toBe(out.length);
    expect(stages.find((stage) => stage.id === "tests")?.saved).toBeLessThan(0);
    // The same text from a command that runs no tests, or with no `outcomes`, gets no digest.
    expect(filterRun(raw, { command: "cat saved-run.log", exitCode: "0", outcomes }).out).not.toContain("--- tests:");
    expect(filterRun(raw, { command: "cargo test", exitCode: "101" }).out).not.toContain("--- tests:");
});
