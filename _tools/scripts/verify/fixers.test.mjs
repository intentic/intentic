// Pins which crates a change set touches and which failing checks may rewrite the tree, since both run unasked at the Stop.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHECKS } from "../../checks/manifest.mjs";
import { crates, fixChecks, touchedCrates } from "./fixers.mjs";

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
