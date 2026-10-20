// Pins which crates a change set touches, which baselines a change may lower, and which derived files it writes again,
// since all of them run unasked wherever a land writes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { doorRule } from "../../checks/doors.rules.mjs";
import { CHECKS } from "../../checks/manifest.mjs";
import { repoRoot } from "../../constants/src/node.mjs";
import { adoptedOf, allowanceOf, tightenedOf } from "../../checks/lib/ratchet.mjs";
import { crates, DERIVED, fixChange, tightenBaselines, touchedCrates, writeDerived } from "./fixers.mjs";
import { touchesTables } from "../tools/layer-tables.mjs";

test("a crate is touched only by a path inside it, and build output is never walked", () => {
    const root = mkdtempSync(join(tmpdir(), "crates-"));
    try {
        for (const dir of ["app/src-tauri", "tools/ic", "node_modules/dep", "app/target/x"]) {
            mkdirSync(join(root, dir), { recursive: true });
            writeFileSync(join(root, dir, "Cargo.toml"), "[package]\n");
        }
        assert.deepEqual(crates(root).sort(), ["app/src-tauri", "tools/ic"]);
        assert.deepEqual(touchedCrates(root, ["tools/ic/src/main.rs", "tools/icing/x.rs", "README.md"]), ["tools/ic"]);
        assert.deepEqual(touchedCrates(root, []), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a layers table is regenerated only for a layers.json or a README beside one", () => {
    const root = mkdtempSync(join(tmpdir(), "layers-"));
    try {
        mkdirSync(join(root, "pkg/src"), { recursive: true });
        mkdirSync(join(root, "plain"), { recursive: true });
        writeFileSync(join(root, "pkg/layers.json"), "{}");
        assert.equal(touchesTables(root, "pkg/layers.json"), true);
        assert.equal(touchesTables(root, "pkg/README.md"), true);
        assert.equal(touchesTables(root, "plain/README.md"), false);
        assert.equal(touchesTables(root, "pkg/src/a.ts"), false);
        // Nothing in scope runs nothing; in scope, a tree without the check has nothing to write.
        assert.deepEqual(writeDerived(root, ["plain/README.md"]), []);
        assert.deepEqual(writeDerived(root, ["pkg/layers.json"]), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a derived file is written again only for its own sources, and counts only when its writer moved it", () => {
    const root = mkdtempSync(join(tmpdir(), "derived-"));
    const out = join(root, "_sandbox/sandbox/src/app-raw-routes.ts");
    try {
        spawnSync("git", ["init", "-q"], { cwd: root });
        // No writer in the tree: nothing to run, whatever changed.
        assert.deepEqual(writeDerived(root, ["_sandbox/sandbox/src/app.ts"]), []);
        mkdirSync(join(root, "_sandbox/sandbox/scripts"), { recursive: true });
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(join(root, "_sandbox/sandbox/scripts/write-indexes.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, "routes\\n");\n`);
        assert.deepEqual(writeDerived(root, ["_sandbox/sandbox/README.md", "docs/a.md"]), []);
        assert.throws(() => readFileSync(out), { code: "ENOENT" });
        assert.deepEqual(writeDerived(root, ["_sandbox/sandbox/src/app.ts"]), ["daemon indexes"]);
        assert.equal(readFileSync(out, "utf8"), "routes\n");
        // Idempotent: the same sources write the same file, which is no move.
        assert.deepEqual(writeDerived(root, ["_sandbox/sandbox/src/app.ts"]), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// The two halves of one declaration: .gitattributes keeps every land and rebase off a derived file, and DERIVED is what
// writes it again. A marked file nothing writes would never reach a tree again; a written file left unmarked would be
// merged as text, the conflict this exists to end (contract.lock.json, 21 refused lands in two weeks of October).
test("every file .gitattributes marks derived has a writer, and every writer's file is marked", () => {
    const root = repoRoot(import.meta.url);
    const marked = spawnSync("git", ["ls-files", "-z", "--", ":(attr:merge=derived)"], { cwd: root, encoding: "utf8" }).stdout.split("\0").filter(Boolean);
    assert.deepEqual(marked.toSorted(), DERIVED.flatMap((writer) => writer.writes).toSorted());
});

test("every check that keeps a baseline says so in the manifest, so the fixers where a land writes can tighten it", () => {
    const checks = join(repoRoot(import.meta.url), "_tools/checks");
    // A check keeps one by calling ratchet() itself, or by running a door rule that is ratcheted (lib/doors.mjs).
    const keeps = (source) =>
        /\bratchet\(/.test(source) || [...source.matchAll(/runDoorRule\(doorRule\(`([^`]+)`\)\)/g)].some(([, id]) => doorRule(id).ratchet === true);
    const keeping = CHECKS.filter((check) => keeps(readFileSync(join(checks, check.file), "utf8"))).map(({ id }) => id);
    assert.deepEqual(CHECKS.filter((check) => check.ratchet === true).map(({ id }) => id), keeping);
});

test("a land whose paths are unknown or empty tightens nothing", () => {
    assert.deepEqual(tightenBaselines(tmpdir(), undefined), []);
    assert.deepEqual(tightenBaselines(tmpdir(), []), []);
});

test("tightening lowers only the entries in scope, keeps a recorded reason, and drops an entry at zero", () => {
    const baseline = { "a.ts": 3, "b.ts": 2, "c.ts": "one, because", "d.ts": { count: 4, why: "grown on purpose" }, "e.ts": 5 };
    const found = new Map([
        ["a.ts", 1],
        ["b.ts", 1],
        ["d.ts", 2],
        ["e.ts", 5],
    ]);
    const { next, lowered } = tightenedOf(baseline, found, (key) => key !== "b.ts");
    assert.deepEqual(next, { "a.ts": 1, "b.ts": 2, "d.ts": { count: 2, why: "grown on purpose" }, "e.ts": 5 });
    assert.deepEqual(lowered, ["a.ts: 3 → 1", "c.ts: 1 → 0", "d.ts: 4 → 2"]);
    // A reasoned count lowered to one keeps the reason alone, which allows exactly one.
    assert.deepEqual(tightenedOf({ "d.ts": { count: 4, why: "w" } }, new Map([["d.ts", 1]]), () => true).next, { "d.ts": "w" });
});

test("adoption records the stated reason on every entry it raises and nowhere else", () => {
    const baseline = { "a.ts": 2, "b.ts": "standing edge", "c.ts": 1 };
    const found = new Map([
        ["a.ts", 4],
        ["b.ts", 1],
        ["c.ts", 1],
        ["n.ts", 1],
    ]);
    assert.deepEqual(Object.fromEntries(adoptedOf(baseline, found, "why")), {
        "a.ts": { count: 4, why: "why" },
        "b.ts": "standing edge",
        "c.ts": 1,
        "n.ts": "why",
    });
    assert.deepEqual([undefined, 3, "r", { count: 5, why: "r" }].map(allowanceOf), [0, 3, 1, 5]);
});

test("the worktree entry refuses without a tree and one change list, and answers what ran and wrote as JSON", () => {
    const script = join(repoRoot(import.meta.url), "_tools/scripts/verify/fixers.mjs");
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(run("--paths", "a.ts").status, 2);
    assert.equal(run("--worktree", tmpdir(), "--paths", "a.ts").status, 2);
    assert.equal(run("--worktree", ".", "--paths", "a.ts", "--since", "HEAD").status, 2);
    const root = mkdtempSync(join(tmpdir(), "fix-change-"));
    try {
        spawnSync("git", ["init", "-q"], { cwd: root });
        writeFileSync(join(root, "README.md"), "x\n");
        // Nothing the change touched has a fixer, so nothing runs and nothing is written, however often it is asked.
        assert.deepEqual(fixChange(root, ["README.md"]), { ran: [], wrote: [] });
        assert.deepEqual(fixChange(root, ["README.md"]), { ran: [], wrote: [] });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
