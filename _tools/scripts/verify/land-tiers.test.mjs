// Pins how lint findings become land units, since a unit that moves with its line number reads as new after any edit above it.
// The reading is measure-change.mjs's, the one every caller lints with.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allowedInRange } from "../../checks/lib/allow.mjs";
import { introduced } from "../../oxlint/added.mjs";
import { repoRoot } from "../../constants/src/node.mjs";
import { LINTABLE } from "./land-tiers.mjs";
import { lintFindings } from "./measure-change.mjs";

const lintUnits = (output) => lintFindings(output).map(({ unit }) => unit);

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

test("an Allow: trailer in the land's range excuses its check, with the reason, and nothing outside the range does", () => {
    const root = mkdtempSync(join(tmpdir(), "allow-range-"));
    const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
        run("init", "-q");
        run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base\n\nAllow: paths — before the range");
        const base = run("rev-parse", "HEAD");
        run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "feat: grow\n\nAllow: layout — the set is one module\nTest-Note: unrelated");
        assert.deepEqual([...allowedInRange(root, base)], [["layout", ["the set is one module"]]]);
        assert.deepEqual([...allowedInRange(root, "no-such-rev")], []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a backlog rule counts only what the change added: a new shape, or a measured value that grew", () => {
    const d = (code, message) => ({ code, message });
    const before = [d("anti-slop(no-chained-type-assertions)", "chain at `a`"), d("complexity(complexity)", "Function has a cognitive complexity of 22 (20).")];
    const after = [
        d("anti-slop(no-chained-type-assertions)", "chain at `a`"),
        d("anti-slop(no-chained-type-assertions)", "chain at `a`"),
        d("complexity(complexity)", "Function has a cognitive complexity of 25 (20)."),
    ];
    assert.deepEqual(introduced(after, before), [after[1], after[2]]);
    assert.deepEqual(introduced(before, before), []);
});

// The complexity rule's message as oxlint-plugin-complexity prints it: the score, then one breakdown line per point.
const scored = (name, score, { metric = "Cognitive Complexity", from = 100 } = {}) => ({
    code: "complexity(complexity)",
    message: `Function '${name}' has ${metric} of ${score}. Maximum allowed is 20. [nested functions: +${score}]\n\nBreakdown:\n${Array.from(
        { length: score },
        (_, index) => `>>> Line ${from + index * 3}: +1 for 'nested arrow function' [top offender]`,
    ).join("\n")}`,
});

test("a complexity finding whose score went down is not new, though its breakdown lost lines", () => {
    assert.deepEqual(introduced([scored("installFakeFly", 38)], [scored("installFakeFly", 40)]), []);
});

test("a complexity finding at the same score with a different breakdown is not new", () => {
    assert.deepEqual(introduced([scored("installFakeFly", 38, { from: 7 })], [scored("installFakeFly", 38)]), []);
});

test("a complexity finding whose score went up is new", () => {
    const grown = scored("installFakeFly", 41);
    assert.deepEqual(introduced([grown], [scored("installFakeFly", 40)]), [grown]);
});

test("a function newly over the limit is new, and a symbol is matched only to its own metric", () => {
    const fresh = scored("parse2", 22);
    const cyclomatic = scored("installFakeFly", 25, { metric: "cyclomatic complexity" });
    assert.deepEqual(introduced([scored("installFakeFly", 38), fresh, cyclomatic], [scored("installFakeFly", 40)]), [fresh, cyclomatic]);
});

test("the plugin tier ignores exactly what the root config ignores, since extends does not carry the list", () => {
    const root = repoRoot(import.meta.url);
    const ignored = (config) => {
        const block = /\n {4}"ignorePatterns": \[\n([\s\S]*?)\n {4}\]/.exec(readFileSync(join(root, config), "utf8"))?.[1] ?? "";
        return [...block.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((match) => match[1]);
    };
    assert.ok(ignored(".oxlintrc.json").length > 0);
    assert.deepEqual(ignored(".oxlintrc.plugins.json"), ignored(".oxlintrc.json"));
});

test("a plugin finding that names its symbol counts once per file: another use of a name already there is not a new name", () => {
    const named = (line) => ({ code: "anti-slop(no-shape-in-symbol-names)", message: `Rename symbol "STATE_SHAPES" for its domain role (${line})` });
    const fresh = { code: "anti-slop(no-shape-in-symbol-names)", message: `Rename symbol "shapeOf" for its domain role` };
    assert.deepEqual(introduced([named(1), named(2), fresh], [named(1)]), [fresh]);
});

test("a lint finding keeps the line as printed, keyed and named without its position, and names its file", () => {
    assert.deepEqual(lintFindings("_tools/a.ts:12:21: Prefer `.at()` over `[index]`. [Error/unicorn(prefer-at)]"), [
        {
            kind: "lint",
            source: "lint",
            recheckable: true,
            text: "_tools/a.ts:12:21: Prefer `.at()` over `[index]`. [Error/unicorn(prefer-at)]",
            key: "lint _tools/a.ts: unicorn(prefer-at) Prefer `.at()` over `[index]`.",
            path: "_tools/a.ts",
            command: "pnpm lint",
            unit: "lint _tools/a.ts: unicorn(prefer-at) Prefer `.at()` over `[index]`.",
        },
    ]);
});
