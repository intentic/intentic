// Pins what the turn check says back to a conversation (verify-turn.mjs): only what its change added, one line per
// finding under the check that found it, and nothing at all for what main already fails, for what a check could not
// measure, or when there is no base to ask. The judging itself is the push check's, pinned in turn-findings.test.mjs
// and measure-change.test.mjs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "../../constants/src/node.mjs";
import { baseOf, checksAt, indexWithNewFiles, LINES_PER_CHECK, turnReport } from "./verify-turn.mjs";

// The shape _tools/checks/run.mjs emits per check.
const verdict = (id, gate, { ok = false, measured = true } = {}) => ({ id, file: `${id}.mjs`, gate, ok, measured, stdout: "", stderr: "", ms: 1 });
const NOTHING = { mine: [], excused: [], unsure: [], theirs: [] };
const BASE = "7ffb812af5c0e7a1d2b3c4d5e6f708192a3b4c5d";
const AT = BASE.slice(0, 9);

const repo = (branch = "main") => {
    const root = mkdtempSync(join(tmpdir(), "verify-turn-"));
    const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const commit = (subject) => {
        run("add", "-A");
        run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", subject);
        return run("rev-parse", "HEAD");
    };
    run("init", "-q", "-b", branch);
    return { root, run, commit };
};

test("each finding the change added is one line under its check, capped, with the command that prints the rest", () => {
    const layout = verdict("layout", "tidy");
    const keys = verdict("i18n-keys", "code");
    const many = Array.from({ length: LINES_PER_CHECK + 2 }, (_, index) => `  - src/dir${index}/: 31 readable files, the limit is 30`);
    const { out, notes, code } = turnReport({
        base: BASE,
        verdicts: [layout, keys, verdict("paths", "tidy", { ok: true })],
        judged: { ...NOTHING, mine: [{ verdict: layout, added: many }, { verdict: keys, added: ["  - web/src/A.vue: sandbox.gone is in no catalog"] }] },
    });
    assert.equal(code, 1);
    assert.deepEqual(out.slice(0, 2), ["✗ layout: src/dir0/: 31 readable files, the limit is 30", "✗ layout: src/dir1/: 31 readable files, the limit is 30"]);
    assert.deepEqual(out.slice(LINES_PER_CHECK - 1, LINES_PER_CHECK + 3), [
        `✗ layout: src/dir${LINES_PER_CHECK - 1}/: 31 readable files, the limit is 30`,
        "✗ layout: … and 2 more",
        "✗ i18n-keys: web/src/A.vue: sandbox.gone is in no catalog",
        `verify-turn: ${LINES_PER_CHECK + 3} finding(s) this change added against ${AT}. Each check's whole report, main's own findings included: node _tools/checks/run.mjs --only layout,i18n-keys`,
    ]);
    // A tidy finding can stand with a reason; how to give one is said once, after the list.
    assert.match(out.at(-1), /^A tidy finding that is right where it stands is declared, with its reason, by an `Allow: <check> — <reason>` line/);
    assert.deepEqual(notes, []);
});

test("a code finding is listed with no word about declaring it: no trailer excuses a tree that does not work", () => {
    const keys = verdict("i18n-keys", "code");
    const { out, code } = turnReport({ base: BASE, verdicts: [keys], judged: { ...NOTHING, mine: [{ verdict: keys, added: ["  - a.vue: x.y"] }] } });
    assert.equal(code, 1);
    assert.deepEqual(out, ["✗ i18n-keys: a.vue: x.y", `verify-turn: 1 finding(s) this change added against ${AT}. Each check's whole report, main's own findings included: node _tools/checks/run.mjs --only i18n-keys`]);
});

// THE POINT OF THE CHECK. Many conversations run at once; a failure main already carries, charged to each of them,
// sends every one of them after the same breakage.
test("what main already fails, what a trailer declared and what the base could not run charge the change with nothing", () => {
    const [layout, paths, literals] = [verdict("layout", "tidy"), verdict("paths", "tidy"), verdict("i18n-literals", "tidy")];
    const { out, notes, code } = turnReport({
        base: BASE,
        verdicts: [layout, paths, literals],
        judged: {
            mine: [],
            theirs: [{ verdict: layout, added: [], unsure: [] }],
            excused: [{ verdict: paths, added: ["  - a.ts:1"], unsure: [], reasons: ["a fixture spells it"] }],
            unsure: [{ verdict: literals, added: [], unsure: ["  - a.vue:3"] }],
        },
    });
    assert.equal(code, 0);
    assert.deepEqual(out, []);
    assert.deepEqual(notes, [
        `layout: already failing at ${AT}, and no worse for this change`,
        "paths (a fixture spells it): declared by an Allow: trailer",
        `i18n-literals: ${AT} could not run these, so nothing they found is charged to this change`,
        `nothing added against ${AT}`,
    ]);
});

test("a check that could not measure is said, and is never a finding", () => {
    const { out, notes, code } = turnReport({ base: BASE, verdicts: [verdict("peer-deps", "tidy", { measured: false })], judged: NOTHING });
    assert.equal(code, 0);
    assert.deepEqual(out, []);
    assert.deepEqual(notes, ["peer-deps: could not measure, so nothing there is judged — the check needs a look, not the change", `nothing added against ${AT}`]);
});

test("a base that could not be asked judges nothing, rather than charging the change with every failure there is", () => {
    const { out, notes, code } = turnReport({ base: BASE, verdicts: [verdict("layout", "tidy"), verdict("paths", "tidy", { ok: true })], judged: undefined });
    assert.equal(code, 0);
    assert.deepEqual(out, []);
    assert.deepEqual(notes, [`${AT} could not be checked out to compare against, so nothing is charged to this change (failing: layout)`]);
});

test("the base is where HEAD left the main line, or the commit --base names, and nothing when neither answers", () => {
    const { root, run, commit } = repo();
    const other = repo("trunk");
    try {
        writeFileSync(join(root, "a.txt"), "a\n");
        const cut = commit("base");
        run("checkout", "-q", "-b", "agent/x");
        writeFileSync(join(root, "a.txt"), "b\n");
        commit("the agent's own commit");
        assert.equal(baseOf(root, undefined), cut);
        assert.equal(baseOf(root, "HEAD"), run("rev-parse", "HEAD"));
        assert.equal(baseOf(root, "no-such-rev"), undefined);
        assert.equal(baseOf(root, ""), undefined);
        // No `main`, and no remote to ask: there is no base, which is not a failure.
        other.commit("only commit");
        assert.equal(baseOf(other.root, undefined), undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(other.root, { recursive: true, force: true });
    }
});

test("the checks a base knew are read from its own manifest, and a base without one answers nothing", async () => {
    const { root, commit } = repo();
    try {
        const bare = commit("no manifest yet");
        mkdirSync(join(root, "_tools/checks"), { recursive: true });
        writeFileSync(join(root, "_tools/checks/manifest.mjs"), `export const CHECKS = [{ id: "layout" }, { id: "paths" }];\n`);
        const listed = commit("a manifest");
        assert.deepEqual([...(await checksAt(root, listed))], ["layout", "paths"]);
        assert.equal(await checksAt(root, bare), undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// A file the turn created is untracked until the work is committed, and most checks list their files with git.
test("the checks' index lists a file nobody has added yet, leaves out what is ignored, and leaves the checkout's own alone", () => {
    const { root, run, commit } = repo();
    const scratch = mkdtempSync(join(tmpdir(), "verify-turn-index-"));
    try {
        writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
        writeFileSync(join(root, "a.txt"), "a\n");
        commit("base");
        writeFileSync(join(root, "a.txt"), "changed\n");
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src/new.ts"), "export {};\n");
        writeFileSync(join(root, "ignored.txt"), "x\n");
        const index = indexWithNewFiles(root, scratch);
        const listed = (env) => execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } }).trim().split("\n");
        assert.deepEqual(listed({ GIT_INDEX_FILE: index }), [".gitignore", "a.txt", "src/new.ts"]);
        assert.deepEqual(listed({}), [".gitignore", "a.txt"]);
        assert.equal(run("status", "--porcelain"), "M a.txt\n?? src/");
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
    }
});

test("a --base that is no commit says so and exits 0: a run that cannot judge is no finding", () => {
    const script = join(repoRoot(import.meta.url), "_tools/scripts/verify/verify-turn.mjs");
    const ran = spawnSync(process.execPath, [script, "--base", "no-such-rev"], { encoding: "utf8" });
    assert.equal(ran.status, 0);
    assert.equal(ran.stdout, "");
    assert.equal(ran.stderr, "verify-turn: --base no-such-rev is not a commit this clone holds, so nothing is judged\n");
});
