// Pins what counts as a stale dist (dist-staleness.mjs): a package a compiler reads declarations of from dist, whose
// dist is missing or older than a source file git says changed, among the packages the asked-for one reads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REBUILD, staleDist, staleDistWarning } from "./dist-staleness.mjs";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

// A package on disk: its manifest, and files with their age in days.
const fakePackage = (root, name, files, { dependencies = {}, declarations = true } = {}) => {
    const dir = join(root, name.replace("@intentic/", ""));
    for (const [file, daysOld] of Object.entries(files)) {
        mkdirSync(join(dir, file, ".."), { recursive: true });
        writeFileSync(join(dir, file), "export {};\n");
        utimesSync(join(dir, file), NOW - daysOld * DAY, NOW - daysOld * DAY);
    }
    const exports = declarations ? { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } : { ".": "./dist/bundle.mjs" };
    return { name: `_shared/${name.replace("@intentic/", "")}`, dir, pkg: { name, exports, dependencies } };
};

test("a dist older than its changed source, or missing, is stale; a current one and a bundle with no declarations are not", () => {
    const root = mkdtempSync(join(tmpdir(), "dist-staleness-"));
    const all = [
        fakePackage(root, "@intentic/old", { "src/a.ts": 1, "dist/index.d.ts": 3, "src/a.test.ts": 0 }),
        fakePackage(root, "@intentic/fresh", { "src/a.ts": 3, "dist/index.d.ts": 1, "src/a.test.ts": 0 }),
        fakePackage(root, "@intentic/unbuilt", { "src/a.ts": 1 }),
        fakePackage(root, "@intentic/bundle", { "src/a.ts": 1, "dist/bundle.mjs": 3 }, { declarations: false }),
    ];
    const stale = staleDist({ all, changed: () => true });
    assert.deepEqual(
        stale.map(({ name, why, rebuild }) => [name, why, rebuild]),
        [
            ["@intentic/old", "dist is 48.0 h older than src/a.ts", REBUILD],
            ["@intentic/unbuilt", "has no dist", REBUILD],
        ],
    );
    // A newer file time git does not back (a checkout's restore of the same text) is no change.
    assert.deepEqual(staleDist({ all, changed: () => false }).map(({ name }) => name), ["@intentic/unbuilt"]);
    assert.match(staleDistWarning(stale) ?? "", /^stale dist: @intentic\/old dist is 48\.0 h older than src\/a\.ts; @intentic\/unbuilt has no dist\. .+: node _tools\/scripts\/build\/emit-declarations\.mjs$/u);
    assert.equal(staleDistWarning([]), undefined);
});

test("asked for one package, only what it reads is checked, its dependencies' dependencies included", () => {
    const root = mkdtempSync(join(tmpdir(), "dist-staleness-"));
    const all = [
        fakePackage(root, "@intentic/app", { "src/a.ts": 0, "dist/index.d.ts": 0 }, { dependencies: { "@intentic/mid": "workspace:*" } }),
        fakePackage(root, "@intentic/mid", { "src/a.ts": 0, "dist/index.d.ts": 0 }, { dependencies: { "@intentic/leaf": "workspace:*" } }),
        fakePackage(root, "@intentic/leaf", { "src/a.ts": 1, "dist/index.d.ts": 2 }),
        fakePackage(root, "@intentic/unrelated", { "src/a.ts": 1 }),
    ];
    assert.deepEqual(staleDist({ all, forPackage: "@intentic/app", changed: () => true }).map(({ name }) => name), ["@intentic/leaf"]);
    assert.deepEqual(staleDist({ all, forPackage: all[0]?.dir, changed: () => true }).map(({ name }) => name), ["@intentic/leaf"]);
});
