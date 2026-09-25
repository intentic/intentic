import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { memoryShort } from "./sandboxFigures";

// The memory gauge warns on the daemon's own verdict for a person's turn: the free memory the budget counts against the
// room that turn needs, and the stall it refuses at. The gate's thresholds arrive with the reading, never restated here.

const GIB = 2 ** 30;

const sandbox = (room: SandboxMetrics[`sandbox`][`memoryRoom`], memoryBytes = 4 * GIB): SandboxMetrics[`sandbox`] => ({
    cores: 4,
    memoryBytes,
    memoryLimitBytes: 16 * GIB,
    loadAverage: [0, 0, 0],
    processes: 10,
    ...(room === undefined ? {} : { memoryRoom: room }),
});

const room = (freeGib: number | undefined, stallPercent = 0): SandboxMetrics[`sandbox`][`memoryRoom`] => ({
    ...(freeGib === undefined ? {} : { freeBytes: freeGib * GIB }),
    reservedBytes: 0,
    personNeedBytes: GIB,
    stallPercent,
    stallLimitPercent: 20,
});

test("the gauge warns exactly where a person's turn would be held: under the room it needs, or at the stall limit", () => {
    expect(memoryShort(sandbox(room(1)))).toBe(false);
    expect(memoryShort(sandbox(room(1 - 1 / 1024)))).toBe(true);
    expect(memoryShort(sandbox(room(8, 19.9)))).toBe(false);
    expect(memoryShort(sandbox(room(8, 20)))).toBe(true);
    // Nothing measured, nothing to hold on: the gate admits, so the gauge stays quiet.
    expect(memoryShort(sandbox(room(undefined)))).toBe(false);
});

// A gauge 95% full on a 64 GiB box still has three gibibytes: the gate admits, so it is not a warning.
test("a full-looking gauge with room for a turn does not warn, since the gate would not hold anyone", () => {
    expect(memoryShort(sandbox(room(3), 15.5 * GIB))).toBe(false);
});

test("a daemon that sends no room falls back to how full the gauge is", () => {
    expect(memoryShort(sandbox(undefined, 14.4 * GIB))).toBe(true);
    expect(memoryShort(sandbox(undefined, 14 * GIB))).toBe(false);
});
