import { test, expect } from "bun:test";
import { admitTurn, headroomFrom, type MemoryHeadroom, readMemoryHeadroom, type TurnAdmission, waitForMemoryHeadroom } from "./memory-admission.js";

const GIB = 1024 ** 3;

// Refusal text, or "" when admitted.
const refusal = (admission: TurnAdmission): string => (admission.admit ? "" : admission.message);

// MemoryHeadroom for a box with no stall and nothing paged out unless given them.
const box = (limitGib: number, usedGib: number, stalledPercent = 0): MemoryHeadroom => ({
    limitBytes: limitGib * GIB,
    usedBytes: usedGib * GIB,
    swapBytes: 0,
    freeBytes: (limitGib - usedGib) * GIB,
    stalledPercent,
});

// A cgroup reading in GiB, as the four files would answer it.
const reading = (limitGib: number | undefined, residentGib: number | undefined, swapGib: number | undefined) => ({
    residentBytes: residentGib === undefined ? undefined : residentGib * GIB,
    limitBytes: limitGib === undefined ? undefined : limitGib * GIB,
    swapBytes: swapGib === undefined ? undefined : swapGib * GIB,
    pressureText: "",
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

// THE INVERSION THIS READING EXISTS TO CLOSE. A sandbox runs with `--memory-swap -1`, so anon pushed to swap leaves
// memory.current and lands in memory.swap.current. Reading only the first made freeBytes RISE as the box began to
// thrash — measured on a 16 GiB cap holding 12.4 resident + 6.8 swapped: 3.6 GiB reported free, every turn admitted,
// while the machine had 350 MB and was paging at 230 MB/s. Whole GiB here so the sum is exact.
test("paging out is counted as used, not as relief", () => {
    const thrashing = headroomFrom(reading(16, 12, 7));
    expect(thrashing.usedBytes).toBe(19 * GIB);
    expect(thrashing.freeBytes).toBe(0);
    expect(admitTurn(thrashing).admit).toBe(false);
    // The same box read as resident-only: what the gate saw before, and it admitted.
    expect(admitTurn(headroomFrom(reading(16, 12, 0))).admit).toBe(true);
});

test("a refusal on a paging box names the swap, since the sum can exceed the cap", () => {
    expect(refusal(admitTurn(headroomFrom(reading(16, 12, 7))))).toContain("12.0 GiB resident + 7.0 GiB swapped, against 16.0 GiB");
});

// The reading rides the refusal so the composer's notice can offer a raise sized against this box, rather than
// re-deriving one from prose. Resident and swapped stay apart, as the message keeps them apart.
test("a headroom refusal carries the reading it was decided on", () => {
    const refused = admitTurn(headroomFrom(reading(16, 12, 7)));
    expect(refused.admit).toBe(false);
    expect(refused.admit === false && refused.memory).toEqual({ limitBytes: 16 * GIB, residentBytes: 12 * GIB, swapBytes: 7 * GIB });
    // An unattended refusal is the same fact about the same box, so it carries the same reading.
    const background = admitTurn({ ...box(10, 8), freeBytes: 2 * GIB - 1 }, true);
    expect(background.admit === false && background.memory).toEqual({ limitBytes: 10 * GIB, residentBytes: 8 * GIB, swapBytes: 0 });
});

// A stalled box is refused on PSI, not on its ceiling: raising the cap is not the answer, so no reading is offered
// and the notice draws no button.
test("a stall refusal carries no reading, since its ceiling is not what is wrong", () => {
    const stalled = admitTurn(box(10, 3, 87));
    expect(stalled.admit).toBe(false);
    expect(stalled.admit === false && stalled.memory).toBeUndefined();
});

// The sentence points at the control, not at the headless spelling: a reader at a composer has a button for this.
test("an interactive refusal names the raise rather than the environment variable", () => {
    const refused = refusal(admitTurn(box(10, 9.5)));
    expect(refused).toContain("raise the sandbox's memory");
    expect(refused).not.toContain("SANDBOX_MEMORY");
});

// Swap being unaccounted (cgroup v1, swapaccount off) must narrow nothing: it is the pre-existing reading, not a
// reason to stop measuring the ceiling that IS readable.
test("an unaccounted swap file reads as none rather than blanking the ceiling", () => {
    const unaccounted = headroomFrom(reading(10, 4, undefined));
    expect(unaccounted.swapBytes).toBe(0);
    expect(unaccounted.freeBytes).toBe(6 * GIB);
    expect(admitTurn(unaccounted).admit).toBe(true);
});

// Unknown ceiling (no cgroup, cgroup v1, hosted) admits rather than refuses on ignorance.
test("a sandbox with no measurable ceiling admits rather than refusing on ignorance", () => {
    const unknown: MemoryHeadroom = { limitBytes: undefined, usedBytes: undefined, swapBytes: 0, freeBytes: undefined, stalledPercent: 0 };
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
