// Pins when a failure counts as a flake, since one wrongly called flaky is a real break that nobody is sent back for.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { flakeCounts, passedAgain, rerunFailures, testUnitParts } from "./flakes.mjs";

const TASK = { taskId: "@s/web#test", name: "@s/web", task: "test", directory: "_editor/web" };

test("a test unit is read back to its file inside the package and its test name", () => {
    assert.deepEqual(testUnitParts("@s/web#test _editor/web/src/a.test.ts › outer > it works", TASK), { file: "src/a.test.ts", name: "outer > it works", unhandled: false });
    assert.deepEqual(testUnitParts("@s/web#test _editor/web/src/b.test.ts › unhandled error: boom", TASK), { file: "src/b.test.ts", unhandled: true });
    assert.deepEqual(testUnitParts("@s/web#test _editor/web/src/c.test.ts › (unnamed)", TASK), { file: "src/c.test.ts", unhandled: true });
    assert.equal(testUnitParts("@s/web#test", TASK), undefined);
    assert.equal(testUnitParts("@s/web#typecheck _editor/web/src/a.ts: TS1 m", { ...TASK, task: "typecheck" }), undefined);
});

test("a re-run clears a unit only when the same case passed, or its whole file ran clean", () => {
    const cases = [
        { file: "src/a.test.ts", name: "ok now", failed: false },
        { file: "src/a.test.ts", name: "still bad", failed: true },
        { file: "src/b.test.ts", name: "fine", failed: false },
    ];
    assert.equal(passedAgain({ file: "src/a.test.ts", name: "ok now", unhandled: false }, cases, []), true);
    assert.equal(passedAgain({ file: "src/a.test.ts", name: "still bad", unhandled: false }, cases, []), false);
    assert.equal(passedAgain({ file: "src/a.test.ts", name: "never ran", unhandled: false }, cases, []), false);
    assert.equal(passedAgain({ file: "src/b.test.ts", unhandled: true }, cases, []), true);
    assert.equal(passedAgain({ file: "src/a.test.ts", unhandled: true }, cases, []), false);
    assert.equal(passedAgain({ file: "src/b.test.ts", unhandled: true }, cases, [{ file: "src/b.test.ts", message: "error: x" }]), false);
    assert.equal(passedAgain({ file: "src/gone.test.ts", unhandled: true }, cases, []), false);
});

test("flakes rank by how often they recur", () => {
    assert.deepEqual(flakeCounts([{ unit: "a" }, { unit: "b" }, { unit: "a" }]), [
        ["a", 2],
        ["b", 1],
    ]);
});

test("a test that fails once and passes alone is flaky, and one that keeps failing is not", () => {
    const root = mkdtempSync(join(tmpdir(), "flake-root-"));
    try {
        const dir = join(root, "pkg");
        mkdirSync(join(dir, "src"), { recursive: true });
        const marker = join(root, "ran-once");
        writeFileSync(
            join(dir, "src/w.test.ts"),
            [
                `import { test, expect } from "bun:test";`,
                `import { existsSync, writeFileSync } from "node:fs";`,
                `test("wobbles", () => { const first = !existsSync(${JSON.stringify(marker)}); writeFileSync(${JSON.stringify(marker)}, ""); expect(first).toBe(false); });`,
                `test("breaks", () => expect(1).toBe(2));`,
            ].join("\n"),
        );
        writeFileSync(marker, "");
        const task = { taskId: "@s/pkg#test", name: "@s/pkg", task: "test", directory: "pkg" };
        const units = ["@s/pkg#test pkg/src/w.test.ts › wobbles", "@s/pkg#test pkg/src/w.test.ts › breaks", "@s/other#test"];
        assert.deepEqual(rerunFailures(root, [task], units), { flaky: [units[0]], still: [units[1], units[2]] });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
