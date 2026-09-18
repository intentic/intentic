// Pins which of a check's findings verify-turn.mjs charges to the turn that is running. The case worth a test is the
// third answer: a check the HEAD snapshot was in no position to run reports lines that are neither known-new nor
// known-standing, and treating those as new once meant whichever turn happened to be running while `i18n-keys` was red
// was sent back to fix ten findings it had not written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blindAtHead, judgeAgainstHead, problemLines } from "./turn-findings.mjs";

// The shape _tools/checks/run.mjs emits per check, with `lines` where a real one writes its findings to stderr.
const verdict = (id, lines, { ok = false, measured = true } = {}) => ({
    id,
    file: `${id}.mjs`,
    gate: "code",
    ok,
    measured,
    stdout: "",
    stderr: lines.length === 0 ? "" : `A heading naming no location:\n${lines.join("\n")}\n`,
});

// What reportsAtHead() builds out of the snapshot's run, assembled here the same way so the test exercises the real
// pairing of `blind` with the lines beside it.
const atHead = (verdicts, lentModules) => new Map(verdicts.map((one) => [one.id, { ok: one.ok, lines: problemLines(one), blind: blindAtHead(one, lentModules) }]));

const DEAD_KEY = "  - _extensions/automations/src/locales/en.json: automationsView.next";
const OTHER_DEAD_KEY = "  - _extensions/workflows/src/locales/en.json: workflowsView.pickOneInChat";
const LITERAL = '  - _editor/web/src/features/workspace/changes/ReviewPanel.vue:1177: "no upstream yet"';

test("a finding the snapshot printed too is standing, and the turn is told so rather than charged", () => {
    const live = [verdict("paths", [DEAD_KEY])];
    const [judged] = judgeAgainstHead(live, atHead([verdict("paths", [DEAD_KEY])], true));
    assert.deepEqual(judged.added, []);
    assert.deepEqual(judged.unsure, []);
});

test("a finding the snapshot did not print is the turn's, and headings are never mistaken for one", () => {
    const live = [verdict("paths", [DEAD_KEY, LITERAL])];
    const [judged] = judgeAgainstHead(live, atHead([verdict("paths", [DEAD_KEY])], true));
    assert.deepEqual(judged.added, [LITERAL]);
    assert.deepEqual(judged.unsure, []);
});

test("a standing finding that moved down the file is the same finding", () => {
    const moved = LITERAL.replace(":1177:", ":1203:");
    const [judged] = judgeAgainstHead([verdict("paths", [moved])], atHead([verdict("paths", [LITERAL])], true));
    assert.deepEqual(judged.added, []);
});

// THE REGRESSION. i18n-keys `needs: "node_modules"`; a snapshot that was not lent an install could not have found
// anything there, so none of what the live run found is evidence of what this turn did.
test("a check the snapshot could not run charges the turn with nothing, and still reports what was found", () => {
    const live = [verdict("i18n-keys", [DEAD_KEY, OTHER_DEAD_KEY])];
    const [judged] = judgeAgainstHead(live, atHead([verdict("i18n-keys", [], { ok: true })], false));
    assert.deepEqual(judged.added, [], "a turn that touched none of the files this check reads must not be sent back for it");
    assert.deepEqual(judged.unsure, [DEAD_KEY, OTHER_DEAD_KEY], "and the findings must still reach whoever is reading");
});

test("a check the snapshot could not run is not credited with passing either", () => {
    // `ok: true` from a blind snapshot is a vacuous pass; reading it as "green at HEAD, red now" would blame the turn
    // for the whole check the moment its findings arrive in a shape the finding pattern misses.
    const live = [verdict("i18n-literals", ["a finding in no recognised shape"])];
    const [judged] = judgeAgainstHead(live, atHead([verdict("i18n-literals", [], { ok: true })], false));
    assert.deepEqual(judged.added, []);
});

test("once the snapshot has the install, the same check is judged line by line again", () => {
    const live = [verdict("i18n-keys", [DEAD_KEY, OTHER_DEAD_KEY])];
    const [judged] = judgeAgainstHead(live, atHead([verdict("i18n-keys", [DEAD_KEY])], true));
    assert.deepEqual(judged.added, [OTHER_DEAD_KEY], "a genuinely new finding is still the turn's, and still fails the gate");
    assert.deepEqual(judged.unsure, []);
});

test("blindness is about the snapshot's position, not about which check it is", () => {
    assert.equal(blindAtHead(verdict("i18n-keys", []), false), true, "needs node_modules, and none were lent");
    assert.equal(blindAtHead(verdict("i18n-keys", []), true), false, "needs node_modules, and they were lent");
    assert.equal(blindAtHead(verdict("paths", []), false), false, "reads the checkout, so an install was never the question");
    assert.equal(blindAtHead(verdict("paths", [], { measured: false }), true), true, "exited `could not measure`: it never looked");
});

test("with no snapshot at all every finding is the turn's, which is the safe direction to be wrong in", () => {
    const [judged] = judgeAgainstHead([verdict("i18n-keys", [DEAD_KEY])], undefined);
    assert.deepEqual(judged.added, [DEAD_KEY]);
    assert.deepEqual(judged.unsure, []);
});

test("a check that passed at HEAD and fails now is the turn's even when its lines are unrecognisable", () => {
    const live = [verdict("paths", ["nothing here names a location"])];
    const [judged] = judgeAgainstHead(live, atHead([verdict("paths", [], { ok: true })], true));
    assert.deepEqual(judged.added, ["paths passed at HEAD and fails now"]);
});
