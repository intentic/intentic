// Pins how a change's findings are read: oxlint's lines, one finding each with the file it names, the range's `Allow:`
// trailers and which checks they answer for, what an edit added to a rule with a backlog (_tools/oxlint/added.mjs), and
// git's own error when a range cannot be listed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allowedInRange } from "../../checks/lib/allow.mjs";
import { repoRoot } from "../../constants/src/node.mjs";
import { introduced } from "../../oxlint/added.mjs";
import { changesSince } from "../lib/git.mjs";
import { lintFindings, sortJudged } from "./measure-change.mjs";

const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "measure-change-"));
    const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    run("init", "-q");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    return { root, head: run("rev-parse", "HEAD") };
};

test("a base git can answer lists every changed path, untracked included", () => {
    const { root, head } = repo();
    try {
        writeFileSync(join(root, "new.md"), "x\n");
        assert.deepEqual(changesSince(root, head), { paths: ["new.md"] });
        assert.match(changesSince(root, "no-such-rev").error, /^git diff --name-only --no-renames no-such-rev: fatal: /);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("oxlint's unix lines become findings as printed, each naming its file, and its summary is not one", () => {
    const output = [
        "_site/site/src/Footer.astro:3:1: Duplicate import of `x`. [Error/import(no-duplicates)]",
        "_tools/a.ts:12:21: Prefer `.at()` over `[index]`. [Error/unicorn(prefer-at)]",
        "",
        "2 problems",
    ].join("\n");
    assert.deepEqual(lintFindings(output), [
        { text: "_site/site/src/Footer.astro:3:1: Duplicate import of `x`. [Error/import(no-duplicates)]", path: "_site/site/src/Footer.astro" },
        { text: "_tools/a.ts:12:21: Prefer `.at()` over `[index]`. [Error/unicorn(prefer-at)]", path: "_tools/a.ts" },
    ]);
});

test("a file oxlint could not parse is a finding too, not a linter that did not run", () => {
    assert.deepEqual(lintFindings("_tools/a.ts:1:11: Unexpected token [Error]\n\n1 problem"), [
        { text: "_tools/a.ts:1:11: Unexpected token [Error]", path: "_tools/a.ts" },
    ]);
});

test("an Allow: trailer in the range excuses its check, with the reason, and nothing outside the range does", () => {
    const root = mkdtempSync(join(tmpdir(), "allow-range-"));
    const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
        run("init", "-q");
        run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base\n\nAllow: paths — before the range");
        const base = run("rev-parse", "HEAD");
        run(
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "feat: grow\n\nAllow: layout — the set is one module\nTest-Note: unrelated",
        );
        assert.deepEqual([...allowedInRange(root, base)], [["layout", ["the set is one module"]]]);
        assert.deepEqual([...allowedInRange(root, "no-such-rev")], []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// The turn check judges `code` checks by what a change added too (verify-turn.mjs), so the one place the two gates
// differ has to hold: a trailer is a reason a tidy finding stands, never a licence for a tree that does not work.
test("a trailer excuses what a change adds to a tidy check, and never what it adds to a code check", () => {
    const { root, head: base } = repo();
    const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
        run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "feat: grow\n\nAllow: layout — one module\nAllow: i18n-keys — later");
        const judged = (id, gate, added, unsure = []) => ({ verdict: { id, gate }, added, unsure });
        const sorted = sortJudged(root, base, [
            judged("layout", "tidy", ["  - a/: 31 files"]),
            judged("i18n-keys", "code", ["  - a.vue: x.y"]),
            judged("paths", "tidy", [], ["  - b.ts:1  spells a root"]),
            judged("silent-catch", "tidy", []),
        ]);
        assert.deepEqual(
            Object.fromEntries(Object.entries(sorted).map(([share, group]) => [share, group.map(({ verdict }) => verdict.id)])),
            { mine: ["i18n-keys"], excused: ["layout"], unsure: ["paths"], theirs: ["silent-catch"] },
        );
        assert.deepEqual(sorted.excused[0].reasons, ["one module"]);
        assert.deepEqual(sortJudged(root, base, []), { mine: [], excused: [], unsure: [], theirs: [] });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a backlog rule counts only what the change added: a new shape, or a measured value that grew", () => {
    const d = (code, message) => ({ code, message });
    const before = [
        d("anti-slop(no-chained-type-assertions)", "chain at `a`"),
        d("complexity(complexity)", "Function has a cognitive complexity of 22 (20)."),
    ];
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
