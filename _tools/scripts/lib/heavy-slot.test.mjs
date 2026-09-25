// Pins how a heavy script knows it already runs inside the sandbox's heavy slot, which is what keeps it from queueing
// behind itself: the slot queue-run names in the environment, or its fd 9, and nothing outside the heavy pool.
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { heldHeavySlot, runInHeavySlot } from "./heavy-slot.mjs";

const QUEUE = "/tmp/q";

test("the slot queue-run names in the environment is held, in the heavy pool only", () => {
    assert.equal(heldHeavySlot({ INTENTIC_QUEUE_DIR: QUEUE, INTENTIC_QUEUE_SLOT: `${QUEUE}/heavy/slot.1` }, "/nonexistent"), `${QUEUE}/heavy/slot.1`);
    assert.equal(heldHeavySlot({ INTENTIC_QUEUE_DIR: QUEUE, INTENTIC_QUEUE_SLOT: `${QUEUE}/tests/slot.1` }, "/nonexistent"), undefined);
    assert.equal(heldHeavySlot({ INTENTIC_QUEUE_DIR: QUEUE }, "/nonexistent"), undefined);
});

test("fd 9 open on a heavy slot is held; open on anything else is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "heavy-slot-"));
    const onSlot = join(dir, "fd9-slot");
    const elsewhere = join(dir, "fd9-other");
    symlinkSync(`${QUEUE}/heavy/slot.2`, onSlot);
    symlinkSync("/proc/1234/statm", elsewhere);
    assert.equal(heldHeavySlot({ INTENTIC_QUEUE_DIR: QUEUE }, onSlot), `${QUEUE}/heavy/slot.2`);
    assert.equal(heldHeavySlot({ INTENTIC_QUEUE_DIR: QUEUE }, elsewhere), undefined);
});

test("off the sandbox, and on a run already queued once, the script goes on at once", () => {
    assert.equal(runInHeavySlot("probe", { env: {}, queueRun: "/nonexistent/queue-run" }), undefined);
    assert.equal(runInHeavySlot("probe", { env: { INTENTIC_HEAVY_REQUEUED: "1" }, queueRun: process.execPath }), undefined);
});
