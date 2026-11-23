// Pins when release-plan.mjs holds a planned release back for RELEASE_MIN_INTERVAL_MINUTES, and that the notice it
// writes is one release-flush.mjs can read the hold's end back out of.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, heldMessage, heldUntil, intervalMinutes } from "./release-hold.mjs";

const hour = 3_600_000;
const released = Date.parse("2026-11-23T10:00:00Z");

test("an unset, empty, zero, negative or unreadable interval holds nothing", () => {
    for (const raw of [undefined, "", "0", "-5", "soon"]) {
        assert.equal(intervalMinutes(raw), 0, String(raw));
    }
    assert.equal(intervalMinutes("180"), 180);
    assert.equal(intervalMinutes("90.5"), 90.5);
});

test("a release planned inside the interval is held until the interval ends", () => {
    assert.deepEqual(decide({ version: "1.2.0", lastReleasedAt: released, now: released + hour, minutes: 180 }), {
        version: "",
        held: true,
        until: released + 3 * hour,
    });
});

test("a release planned once the interval is over goes ahead", () => {
    assert.deepEqual(decide({ version: "1.2.0", lastReleasedAt: released, now: released + 3 * hour, minutes: 180 }), { version: "1.2.0", held: false });
});

test("nothing to release, no interval, or no earlier release is never a hold", () => {
    assert.deepEqual(decide({ version: "", lastReleasedAt: released, now: released, minutes: 180 }), { version: "", held: false });
    assert.deepEqual(decide({ version: "1.2.0", lastReleasedAt: released, now: released, minutes: 0 }), { version: "1.2.0", held: false });
    assert.deepEqual(decide({ version: "1.2.0", lastReleasedAt: undefined, now: released, minutes: 180 }), { version: "1.2.0", held: false });
    assert.deepEqual(decide({ version: "1.2.0", lastReleasedAt: Number.NaN, now: released, minutes: 180 }), { version: "1.2.0", held: false });
});

test("the flush reads the hold's end back out of the notice the planner wrote", () => {
    const until = released + 3 * hour;
    assert.equal(heldUntil(heldMessage({ version: "1.2.0", until, lastTag: "v1.1.0", minutes: 180 })), until);
    assert.equal(heldUntil("some other notice"), undefined);
    assert.equal(heldUntil(undefined), undefined);
});
