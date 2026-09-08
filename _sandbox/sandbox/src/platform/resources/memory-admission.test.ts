import { expect, test } from "vitest";
import { admitTurn, type MemoryHeadroom, readMemoryHeadroom, type TurnAdmission, waitForMemoryHeadroom } from "./memory-admission.js";

const GIB = 1024 ** 3;

// Refusal text, or "" when admitted.
const refusal = (admission: TurnAdmission): string => (admission.admit ? "" : admission.message);

// MemoryHeadroom for a box with no stall unless given one.
const box = (limitGib: number, usedGib: number, stalledPercent = 0): MemoryHeadroom => ({
    limitBytes: limitGib * GIB,
    usedBytes: usedGib * GIB,
    freeBytes: (limitGib - usedGib) * GIB,
    stalledPercent,
});

test("a box with room admits, a box without it refuses and says what is used", () => {
    expect(admitTurn(box(10, 4))).toEqual({ admit: true });
    const refused = admitTurn(box(10, 9.5));
    expect(refused.admit).toBe(false);
    expect(refusal(refused)).toContain("9.5 GiB of 10.0 GiB");
});

test("a turn needs a gibibyte free; unattended turns need two", () => {
    expect(admitTurn({ ...box(10, 9), freeBytes: GIB }).admit).toBe(true);
    expect(admitTurn({ ...box(10, 9), freeBytes: GIB - 1 }).admit).toBe(false);
    expect(admitTurn({ ...box(10, 8), freeBytes: 2 * GIB }, true).admit).toBe(true);
    expect(admitTurn({ ...box(10, 8), freeBytes: 2 * GIB - 1 }, true).admit).toBe(false);
});

test("on a box with room for exactly one turn, the interactive one wins", () => {
    const tight = { ...box(10, 8.5), freeBytes: 1.5 * GIB };
    expect(admitTurn(tight, false).admit).toBe(true);
    expect(admitTurn(tight, true).admit).toBe(false);
    expect(refusal(admitTurn(tight, true))).toMatch(/nothing is lost/u);
});

test("a stalled box is refused even when the byte count looks survivable", () => {
    expect(admitTurn(box(10, 3, 87)).admit).toBe(false);
    expect(refusal(admitTurn(box(10, 3, 87)))).toContain("87%");
    // Healthy readings sit at 0; the threshold must not fire on ordinary reclaim noise.
    expect(admitTurn(box(10, 3, 0)).admit).toBe(true);
    expect(admitTurn(box(10, 3, 5)).admit).toBe(true);
});

// Unknown ceiling (no cgroup, cgroup v1, hosted) admits rather than refuses on ignorance.
test("a sandbox with no measurable ceiling admits rather than refusing on ignorance", () => {
    const unknown: MemoryHeadroom = { limitBytes: undefined, usedBytes: undefined, freeBytes: undefined, stalledPercent: 0 };
    expect(admitTurn(unknown)).toEqual({ admit: true });
    expect(admitTurn(unknown, true)).toEqual({ admit: true });
    // Stalling still admits: without a ceiling, pressure reads the whole machine's, not this sandbox's.
    expect(admitTurn({ ...unknown, stalledPercent: 95 })).toEqual({ admit: true });
});

test("reading headroom degrades to an admitting verdict instead of throwing", async () => {
    const headroom = await readMemoryHeadroom();
    expect(typeof headroom.stalledPercent).toBe("number");
    expect(admitTurn(headroom)).toHaveProperty("admit");
});

test("a box with room is admitted on the first reading, with no wait", async () => {
    const wait = await waitForMemoryHeadroom({ read: () => Promise.resolve(box(10, 4)) });
    expect(wait).toEqual({ admitted: true, waitedMs: 0 });
});

test("a transient peak is waited out, and the wait is reported", async () => {
    const readings = [box(10, 9.5), box(10, 9.5), box(10, 4)];
    const wait = await waitForMemoryHeadroom({ intervalMs: 1, read: () => Promise.resolve(readings.shift() ?? box(10, 4)) });
    expect(wait.admitted).toBe(true);
    expect(wait.waitedMs).toBeGreaterThan(0);
});

test("an exhausted deadline reports unadmitted with the refusal's own words, never hangs", async () => {
    const wait = await waitForMemoryHeadroom({ intervalMs: 1, deadlineMs: 3, read: () => Promise.resolve(box(10, 9.9)) });
    expect(wait.admitted).toBe(false);
    expect(wait.message).toContain("GiB");
});

test("the wait is held to the unattended reserve, not the interactive one", async () => {
    const oneTurn = { ...box(10, 8.5), freeBytes: 1.5 * GIB };
    const wait = await waitForMemoryHeadroom({ intervalMs: 1, deadlineMs: 3, read: () => Promise.resolve(oneTurn) });
    expect(wait.admitted).toBe(false);
});

test("an abort ends the wait without the deadline", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const wait = await waitForMemoryHeadroom({
        intervalMs: 60_000,
        deadlineMs: 600_000,
        signal: controller.signal,
        read: () => Promise.resolve(box(10, 9.9)),
    });
    expect(wait.admitted).toBe(false);
});
