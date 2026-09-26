// Pins which shapes of `shared.*` message the i18n-shared check refuses, and that its excuse list cannot rot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notANoun, sharedFindings } from "./lib/shared-nouns.mjs";

const ACTIONS = ["Cancel", "Show fewer", "Retry"];

test("nouns, states and a possessive noun phrase pass", () => {
    for (const [key, message] of [
        ["agent", "Agent"],
        ["running", "Running"],
        ["upToDate", "up to date"],
        ["connections", "Your connections"],
        ["thisSandbox", "This sandbox"],
        ["preview", "Preview"],
        ["hereNow", "Here now"],
    ]) {
        assert.deepEqual(notANoun(key, message, ACTIONS), [], `${key} "${message}"`);
    }
});

test("each shape that is never a noun phrase is refused, for its own reason", () => {
    const refused = (key, message) => notANoun(key, message, ACTIONS).join(" | ");
    assert.match(refused("sandbox2", "Sandbox"), /ends in a digit/);
    assert.match(refused("resets", "resets {resetsAt}"), /placeholder/);
    assert.match(refused("temporary", ", temporary"), /fragment/);
    assert.match(refused("more", "More…"), /fragment/);
    assert.match(refused("and", "and"), /conjunction/);
    assert.match(refused("pair", "Q & A"), /conjunction/);
    assert.match(refused("you", "you"), /pronoun/);
    assert.match(refused("waiting", "waiting for you"), /pronoun/);
    assert.match(refused("showAll", "Show all"), /verb "show"/);
    assert.match(refused("cancel", "Cancel"), /verb "cancel"/);
    assert.match(refused("again", "Retry"), /already says it as a verb/);
});

test("a vue-i18n literal is not a placeholder", () => {
    assert.deepEqual(notANoun("brace", "Braces {'{'}", ACTIONS), []);
});

test("an allowed message passes, and an excuse with no reason or nothing left to excuse is a finding", () => {
    const shared = { agent: "Agent", needs: "Needs you", or: "or" };
    assert.deepEqual(sharedFindings(shared, ACTIONS, { "shared.needs": "the awaiting state's name" }), [
        'shared.or "or": "or" is a conjunction',
    ]);
    assert.deepEqual(sharedFindings(shared, ACTIONS, { "shared.needs": "", "shared.agent": "why", "shared.gone": "why", "shared.or": "why" }), [
        "shared.needs: allowed without a reason",
        "shared.agent: allowed, but it no longer needs to be (delete the entry)",
        "shared.gone: allowed, but it no longer needs to be (delete the entry)",
    ]);
});

test("a nested group under shared is refused", () => {
    assert.deepEqual(sharedFindings({ group: { a: "A" } }, ACTIONS, {}), ["shared.group: a nested group; shared.* is a flat list of words"]);
});
