// Pins which crates a change set touches and which failing checks may rewrite the tree, since both run unasked at the Stop.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHECKS } from "../../checks/manifest.mjs";
import { repoRoot } from "../../constants/src/node.mjs";
import { adoptedOf, allowanceOf, tightenedOf } from "../../checks/lib/ratchet.mjs";
import { crates, fixChecks, tightenBaselines, touchedCrates } from "./fixers.mjs";

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

test("only a failing, measured check that declares a fix is run as a fixer", () => {
    const withoutFix = CHECKS.find((check) => check.fix === undefined);
    const verdicts = [
        { id: withoutFix.id, ok: false, measured: true },
        { id: "i18n", ok: true, measured: true },
    ];
    assert.deepEqual(fixChecks(tmpdir(), verdicts), []);
    assert.ok(CHECKS.filter((check) => check.fix !== undefined).every((check) => Array.isArray(check.fix)));
});

test("every check that keeps a baseline says so in the manifest, so the check after a land can tighten it", () => {
    const checks = join(repoRoot(import.meta.url), "_tools/checks");
    const keeping = CHECKS.filter((check) => /\bratchet\(/.test(readFileSync(join(checks, check.file), "utf8"))).map(({ id }) => id);
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
