import assert from "node:assert/strict";
import { test } from "node:test";
import { REBUILD } from "./dist-staleness.mjs";
import { rebuildCommands, rebuildNote, rebuildStale } from "./dist-rebuild.mjs";

// What a run rebuilds is exactly what it found stale, in one scoped emit, and what it says is what happened.

const STALE = [
    { name: "@intentic/base", dir: "_tools/base", why: "has no dist", rebuild: REBUILD },
    { name: "@intentic/constants", dir: "_tools/constants", why: "dist is 2 h older than src/a.ts", rebuild: REBUILD },
    { name: "@intentic/extension-ui", dir: "_shared/extension-ui", why: "has no dist", rebuild: "pnpm --filter @intentic/extension-ui build" },
];

test("one scoped emit for the packages it builds, then each package's own build", () => {
    assert.deepEqual(rebuildCommands(STALE), [`${REBUILD} _tools/base _tools/constants`, "pnpm --filter @intentic/extension-ui build"]);
    assert.deepEqual(rebuildCommands([]), []);
});

test("a rebuild that takes says what it rebuilt; one that fails keeps the warning and says why", () => {
    const ran = [];
    const ok = rebuildStale(STALE, { run: (command) => (ran.push(command), { status: 0, stdout: "", stderr: "" }) });
    assert.equal(ran.length, 2);
    assert.match(rebuildNote(STALE, ok), /^rebuilt stale dist before running \(@intentic\/base, @intentic\/constants, @intentic\/extension-ui; \d+ s\)$/u);

    const failed = rebuildStale(STALE, { run: () => ({ status: 2, stdout: "", stderr: "error TS2307: Cannot find module" }) });
    assert.equal(failed.ok, false);
    const note = rebuildNote(STALE, failed);
    for (const part of ["stale dist: @intentic/base has no dist", "the automatic rebuild failed", "Cannot find module"]) {
        assert.ok(note.includes(part), part);
    }
});
