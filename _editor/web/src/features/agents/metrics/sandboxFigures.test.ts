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

type Room = NonNullable<SandboxMetrics[`sandbox`][`memoryRoom`]>;

const room = (freeGib: number | undefined, stallPercent = 0): Room => ({
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

// A sandbox paging hard flickers under the ten-second limit; the minute's average is what holds the turn then.
test("the gauge warns at the minute's stall limit too, and a daemon that sends none warns on the ten seconds alone", () => {
    const sustained = (percent: number): Room => ({
        ...room(8, 17),
        stallSustainedPercent: percent,
        stallSustainedLimitPercent: 10,
    });
    expect(memoryShort(sandbox(sustained(9.9)))).toBe(false);
    expect(memoryShort(sandbox(sustained(10)))).toBe(true);
    expect(memoryShort(sandbox({ ...room(8, 17), stallSustainedPercent: 50 }))).toBe(false);
});

// A gauge 95% full on a 64 GiB box still has three gibibytes: the gate admits, so it is not a warning.
test("a full-looking gauge with room for a turn does not warn, since the gate would not hold anyone", () => {
    expect(memoryShort(sandbox(room(3), 15.5 * GIB))).toBe(false);
});

// A daemon older than `memoryRoom` gives no verdict, and none is guessed from how full the gauge is.
test("a reading without room warns of nothing, however full the gauge", () => {
    expect(memoryShort(sandbox(undefined, 15.9 * GIB))).toBe(false);
    expect(memoryShort(sandbox(undefined, 4 * GIB))).toBe(false);
});
