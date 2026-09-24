// Pins how lint findings become land units, since a unit that moves with its line number reads as new after any edit above it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LINTABLE, lintUnits } from "./land-tiers.mjs";

test("oxlint's unix lines become units without positions, and its summary is not one", () => {
    const output = [
        "_site/site/src/Footer.astro:3:1: Duplicate import of `x`. [Error/import(no-duplicates)]",
        "_tools/a.ts:12:21: Prefer `.at()` over `[index]`. [Error/unicorn(prefer-at)]",
        "",
        "2 problems",
    ].join("\n");
    assert.deepEqual(lintUnits(output), [
        "lint _site/site/src/Footer.astro: import(no-duplicates) Duplicate import of `x`.",
        "lint _tools/a.ts: unicorn(prefer-at) Prefer `.at()` over `[index]`.",
    ]);
});

test("a file oxlint could not parse is a unit too, not a linter that did not run", () => {
    assert.deepEqual(lintUnits("_tools/a.ts:1:11: Unexpected token [Error]\n\n1 problem"), ["lint _tools/a.ts: parse Unexpected token"]);
});

test("the lintable set is the push's, .astro included", () => {
    assert.deepEqual(
        ["a.ts", "b.mjs", "c.vue", "d.astro", "e.json", "f.md"].filter((path) => LINTABLE.test(path)),
        ["a.ts", "b.mjs", "c.vue", "d.astro"],
    );
});
