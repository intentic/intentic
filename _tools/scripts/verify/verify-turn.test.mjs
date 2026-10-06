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
import { baseOf, checksAt, indexWithNewFiles, LINES_PER_CHECK, renamesSince, run, runGuarded, turnReport } from "./verify-turn.mjs";

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

// A moved file keeps its findings: git pairs the new path with the old one, through the index that lists new files too.
test("the files the change moved are paired with where the base had them, committed or not", () => {
    const { root, run: git, commit } = repo();
    const scratch = mkdtempSync(join(tmpdir(), "verify-turn-index-"));
    try {
        writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
        writeFileSync(join(root, "b.txt"), "five\nsix\nseven\neight\n");
        const cut = commit("base");
        git("checkout", "-q", "-b", "agent/x");
        mkdirSync(join(root, "sub"));
        // Moved without `git mv`: a deletion and an untracked file to git until the index lists the new one.
        execFileSync("mv", [join(root, "a.txt"), join(root, "sub/a.txt")]);
        assert.deepEqual([...renamesSince(root, cut)], []);
        const index = indexWithNewFiles(root, scratch);
        assert.deepEqual([...renamesSince(root, cut, { ...process.env, GIT_INDEX_FILE: index })], [["sub/a.txt", "a.txt"]]);
        git("mv", "b.txt", "sub/b.txt");
        commit("moved");
        assert.deepEqual([...renamesSince(root, cut)].toSorted(), [["sub/a.txt", "a.txt"], ["sub/b.txt", "b.txt"]].toSorted());
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
    }
});

// Exit 1 says "this change added findings"; a run that fell over says nothing about the change.
test("a run that fails for a fault of its own says so on stderr and exits 0, never as a finding", async () => {
    const { root, run: git, commit } = repo();
    const tmp = process.env.TMPDIR;
    const write = process.stderr.write;
    let said = "";
    try {
        writeFileSync(join(root, "a.txt"), "a\n");
        commit("base");
        git("checkout", "-q", "-b", "agent/x");
        writeFileSync(join(root, "a.txt"), "b\n");
        // The checks' scratch directory cannot be made.
        process.env.TMPDIR = join(root, "no-such-dir");
        await assert.rejects(run(root, []), /ENOENT/);
        process.stderr.write = (text) => {
            said += text;
            return true;
        };
        assert.equal(await runGuarded(root, []), 0);
        assert.match(said, /^verify-turn: could not judge the change \(ENOENT.*\), so nothing is judged\n$/);
    } finally {
        process.stderr.write = write;
        if (tmp === undefined) {
            delete process.env.TMPDIR;
        } else {
            process.env.TMPDIR = tmp;
        }
        rmSync(root, { recursive: true, force: true });
    }
});

// The whole run over a checkout of its own, with a stand-in for the checks: one that finds a `.bad` file, as printed
// `  - <path>:1 smell`. A finding main already has stays main's when its file is only moved.
test("moving a file that already has a finding is not adding one, and a new one is", async () => {
    const { root, run: git, commit } = repo();
    const outWrite = process.stdout.write;
    const errWrite = process.stderr.write;
    let out = "";
    const quiet = async (fn) => {
        process.stdout.write = (text) => ((out += text), true);
        process.stderr.write = () => true;
        try {
            return await fn();
        } finally {
            process.stdout.write = outWrite;
            process.stderr.write = errWrite;
        }
    };
    try {
        mkdirSync(join(root, "_tools/checks"), { recursive: true });
        writeFileSync(join(root, "_tools/checks/manifest.mjs"), `export const CHECKS = [{ id: "smell", gate: "tidy" }];\n`);
        writeFileSync(
            join(root, "_tools/checks/run.mjs"),
            `import { spawnSync } from "node:child_process";
const files = spawnSync("git", ["ls-files"], { encoding: "utf8" }).stdout.split("\\n").filter((file) => file.endsWith(".bad"));
process.stdout.write(JSON.stringify([{ id: "smell", gate: "tidy", measured: true, ok: files.length === 0, stdout: files.map((file) => "  - " + file + ":1 smell").join("\\n"), stderr: "" }]));\n`,
        );
        writeFileSync(join(root, "a.bad"), "one\ntwo\nthree\nfour\n");
        commit("main already has a finding");
        git("checkout", "-q", "-b", "agent/x");
        mkdirSync(join(root, "sub"));
        git("mv", "a.bad", "sub/a.bad");
        assert.equal(await quiet(() => run(root, [])), 0);
        assert.equal(out, "");
        writeFileSync(join(root, "new.bad"), "x\n");
        assert.equal(await quiet(() => run(root, [])), 1);
        assert.match(out, /^✗ smell: new\.bad:1 smell\n/);
        assert.doesNotMatch(out, /sub\/a\.bad/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
