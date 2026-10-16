// Pins how code-shape keys a measurement to its baseline entry: growth fails, and a rename, a reorder, a move, a git mv
// or a split carries the allowance it had (lib/shape.mjs), which --tighten writes under the new name (lib/ratchet.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { transferredOf } from "./lib/ratchet.mjs";
import { complexityOf, findingOf, ignoredBy, judge, lineCount, parseJsonc, partsOf, qualified, touchedBy } from "./lib/shape.mjs";

const METRICS = new Set([`file`, `lines`, `cyclomatic`, `cognitive`]);
const fn = (path, symbol, metric, value, line = 1) => ({ path, symbol, metric, value, line });
const file = (path, value) => ({ path, metric: `file`, value, line: 1 });

// The keys the ratchet would refuse: what a measurement holds past its entry plus what it borrowed.
const grownOf = (items, baseline, { lines = {}, gone = [] } = {}) => {
    const { keyed, lent } = judge({
        items,
        baseline: new Map(Object.entries(baseline)),
        measuredPath: () => true,
        metrics: METRICS,
        linesOf: (path) => (gone.includes(path) ? undefined : (lines[path] ?? items.find((item) => item.path === path && item.metric === `file`)?.value ?? 0)),
    });
    return [...keyed].filter(([key, item]) => item.value > (baseline[key] ?? 0) + (lent.get(key)?.count ?? 0)).map(([key]) => key);
};

test("an over-cap file that grows fails, and one that holds or shrinks passes", () => {
    assert.deepEqual(grownOf([file(`a.ts`, 710)], { "a.ts": 700 }), [`a.ts`]);
    assert.deepEqual(grownOf([file(`a.ts`, 650)], { "a.ts": 700 }), []);
});

test("a new file over 600 lines fails", () => {
    assert.deepEqual(grownOf([file(`b.ts`, 601)], {}), [`b.ts`]);
});

test("a function or a score past its baseline fails, and one new over the cap fails", () => {
    assert.deepEqual(grownOf([fn(`a.ts`, `foo`, `lines`, 151)], { "a.ts#foo#lines": 150 }), [`a.ts#foo#lines`]);
    assert.deepEqual(grownOf([fn(`a.ts`, `foo`, `cognitive`, 31)], { "a.ts#foo#cognitive": 30 }), [`a.ts#foo#cognitive`]);
    assert.deepEqual(grownOf([fn(`a.ts`, `bar`, `cyclomatic`, 21)], {}), [`a.ts#bar#cyclomatic`]);
});

test("a function renamed in its file keeps its allowance", () => {
    assert.deepEqual(grownOf([fn(`a.ts`, `bar`, `cognitive`, 30)], { "a.ts#foo#cognitive": 30 }), []);
    assert.deepEqual(grownOf([fn(`a.ts`, `bar`, `cognitive`, 31)], { "a.ts#foo#cognitive": 30 }), [`a.ts#bar#cognitive`]);
});

test("reordering functions of one name pairs each with its own entry", () => {
    const baseline = { "a.ts#x.<anonymous>#lines": 120, "a.ts#x.<anonymous>~2#lines": 150 };
    assert.deepEqual(grownOf([fn(`a.ts`, `x.<anonymous>`, `lines`, 150, 10), fn(`a.ts`, `x.<anonymous>`, `lines`, 120, 200)], baseline), []);
    // A new one of that name is the change's, whichever position it takes.
    const added = [fn(`a.ts`, `x.<anonymous>`, `lines`, 130, 5), fn(`a.ts`, `x.<anonymous>`, `lines`, 150, 10), fn(`a.ts`, `x.<anonymous>`, `lines`, 120, 200)];
    assert.deepEqual(grownOf(added, baseline), [`a.ts#x.<anonymous>~3#lines`]);
});

test("a function moved to another file keeps its allowance; a copy that leaves the original does not", () => {
    assert.deepEqual(grownOf([fn(`b.ts`, `foo`, `lines`, 150)], { "a.ts#foo#lines": 150 }), []);
    assert.deepEqual(grownOf([fn(`a.ts`, `foo`, `lines`, 150), fn(`b.ts`, `foo`, `lines`, 150)], { "a.ts#foo#lines": 150 }), [`b.ts#foo#lines`]);
    // Moved and renamed at once is two changes, and the second is not carried.
    assert.deepEqual(grownOf([fn(`b.ts`, `bar`, `lines`, 150)], { "a.ts#foo#lines": 150 }), [`b.ts#bar#lines`]);
});

test("a git mv of a big file carries the file and its functions", () => {
    const baseline = { "old/a.ts": 900, "old/a.ts#foo#cognitive": 40 };
    assert.deepEqual(grownOf([file(`new/a.ts`, 900), fn(`new/a.ts`, `foo`, `cognitive`, 40)], baseline, { gone: [`old/a.ts`] }), []);
});

test("a split carries what the source file gave up, and no more", () => {
    assert.deepEqual(grownOf([file(`d/a.ts`, 700), file(`d/b.ts`, 800)], { "d/a.ts": 1400 }), []);
    assert.deepEqual(grownOf([file(`d/a.ts`, 900), file(`d/b.ts`, 1200)], { "d/a.ts": 1400 }), [`d/b.ts`]);
    // A function moving into a file already over the cap is paid for by the file it left.
    assert.deepEqual(grownOf([file(`d/a.ts`, 650), file(`d/c.ts`, 760)], { "d/a.ts": 800, "d/c.ts": 700 }), []);
});

test("tighten writes a borrowed allowance under the new key and drops the one it came from", () => {
    const why = `standing when the check arrived (2026-10-16)`;
    const baseline = { "a.ts#foo#lines": { count: 150, why }, "a.ts": { count: 1400, why } };
    const found = new Map([
        [`b.ts#foo#lines`, 140],
        [`b.ts`, 800],
    ]);
    const lent = new Map([
        [`b.ts#foo#lines`, { from: `a.ts#foo#lines`, count: 150 }],
        [`b.ts`, { from: `a.ts`, count: 800 }],
    ]);
    const { next, moved } = transferredOf(baseline, found, lent, () => true);
    assert.deepEqual(next, { "b.ts#foo#lines": { count: 140, why }, "b.ts": { count: 800, why } });
    assert.deepEqual(moved, [`b.ts#foo#lines`, `b.ts`]);
    // A change that touched only the new file moves nothing: the old entry is not its to give.
    assert.deepEqual(transferredOf(baseline, found, lent, (key) => touchedBy(key, `b.ts`)).moved, []);
});

test("keys name their file, so --tighten <path> reaches a file's functions and nothing else's", () => {
    assert.deepEqual(partsOf(`a/b.ts#x.<anonymous>~2#cognitive`), { path: `a/b.ts`, symbol: `x.<anonymous>`, metric: `cognitive` });
    assert.deepEqual(partsOf(`a/b.ts`), { path: `a/b.ts`, metric: `file` });
    assert.equal(touchedBy(`a/b.ts#foo#lines`, `a/b.ts`), true);
    assert.equal(touchedBy(`a/b.ts`, `a/b.ts`), true);
    assert.equal(touchedBy(`a/b.tsx#foo#lines`, `a/b.ts`), false);
});

test("an anonymous function is named after its nearest named enclosing function", () => {
    const named = qualified([
        { name: `outer`, startLine: 1, endLine: 50 },
        { name: `<anonymous>`, startLine: 2, endLine: 20 },
        { name: `<anonymous>`, startLine: 3, endLine: 10 },
        { name: `<anonymous>`, startLine: 60, endLine: 70 },
    ]);
    assert.deepEqual(
        named.map((each) => each.name),
        [`outer`, `outer.<anonymous>`, `outer.<anonymous>`, `<anonymous>`],
    );
});

test("the plugin's messages read as metric, score and name", () => {
    assert.deepEqual(complexityOf(`Function 'createApp' has Cognitive Complexity of 21. Maximum allowed is 20. [nested functions: +20]`), {
        metric: `cognitive`,
        score: 21,
        name: `createApp`,
    });
    assert.deepEqual(complexityOf(`Function '<arrow>' has cyclomatic complexity of 30. Maximum allowed is 20.`), { metric: `cyclomatic`, score: 30, name: `<arrow>` });
    assert.equal(complexityOf(`Rename symbol "x"`), undefined);
});

test("a finding is anchored path:line with its numbers standing alone", () => {
    assert.equal(findingOf(fn(`a.ts`, `foo`, `cognitive`, 31, 12), 30), "a.ts:12  `foo` cognitive complexity 31, past its baseline of 30");
    assert.equal(findingOf(file(`a.ts`, 601), 0), `a.ts:1  601 lines in a file with no baseline entry, over the cap of 600`);
});

test("lines count as an editor numbers them, and the config's ignore list and comments read as oxlint reads them", () => {
    assert.equal(lineCount(`a\nb\n`), 2);
    assert.equal(lineCount(`a\nb`), 2);
    const ignored = ignoredBy([`**/dist`, `**/dist-*`, `_editor/web/public/ext-shims`]);
    assert.equal(ignored(`x/dist/a.js`), true);
    assert.equal(ignored(`x/dist-web/a.js`), true);
    assert.equal(ignored(`_editor/web/public/ext-shims/a.js`), true);
    assert.equal(ignored(`x/distant/a.js`), false);
    assert.deepEqual(parseJsonc(`{\n  // a "comment"\n  "a": "./x//y", /* b */\n  "b": [1, 2,],\n}`), { a: `./x//y`, b: [1, 2] });
});
