import { expect, test } from "vitest";
import { admitTurn, type MemoryHeadroom, readMemoryHeadroom, type TurnAdmission, waitForMemoryHeadroom } from "./memory-admission.js";

const GIB = 1024 ** 3;

// The refusal sentence, or "" when the verdict admitted — narrowing in one place so the assertions below read
// as what they check rather than as type gymnastics.
const refusal = (admission: TurnAdmission): string => (admission.admit ? "" : admission.message);

// A box of `limitGib` with `usedGib` on it and nothing stalling, the shape a healthy sandbox reports.
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
    // The numbers have to be IN the message: "not enough memory" with no figures is unactionable, and the
    // owner's next question is always "how much of what".
    expect(refusal(refused)).toContain("9.5 GiB of 10.0 GiB");
});

/* The reserve is what a turn COSTS, not a round number: a provider CLI measured at ~200 MiB plus whatever the
 * agent then runs. Asserted at the boundary from both sides so a change to it is a deliberate edit here. */
test("a turn needs a gibibyte free; unattended turns need two", () => {
    expect(admitTurn({ ...box(10, 9), freeBytes: GIB }).admit).toBe(true);
    expect(admitTurn({ ...box(10, 9), freeBytes: GIB - 1 }).admit).toBe(false);
    expect(admitTurn({ ...box(10, 8), freeBytes: 2 * GIB }, true).admit).toBe(true);
    expect(admitTurn({ ...box(10, 8), freeBytes: 2 * GIB - 1 }, true).admit).toBe(false);
});

/* Triage, not fairness: the same box that turns away a scheduled wake still serves the person typing into it.
 * If these two ever collapse to the same threshold, a background follow-up can take the last gibibyte out from
 * under an interactive turn, which is the case the split exists to prevent. */
test("on a box with room for exactly one turn, the interactive one wins", () => {
    const tight = { ...box(10, 8.5), freeBytes: 1.5 * GIB };
    expect(admitTurn(tight, false).admit).toBe(true);
    expect(admitTurn(tight, true).admit).toBe(false);
    // And the refusal tells a background turn it is coming back, because it is: nothing was lost.
    expect(refusal(admitTurn(tight, true))).toMatch(/nothing is lost/u);
});

/* The backstop for a box that still has swap: it never "runs out", it grinds, so freeBytes can look survivable
 * while every task inside is stalled. Pinned at the incident's own reading, which sat between 80 and 98. */
test("a stalled box is refused even when the byte count looks survivable", () => {
    expect(admitTurn(box(10, 3, 87)).admit).toBe(false);
    expect(refusal(admitTurn(box(10, 3, 87)))).toContain("87%");
    // Healthy boxes read 0 essentially always; the threshold must not fire on ordinary reclaim noise.
    expect(admitTurn(box(10, 3, 0)).admit).toBe(true);
    expect(admitTurn(box(10, 3, 5)).admit).toBe(true);
});

/* AN UNKNOWN CEILING ADMITS. The hosted shape carries no cap, a dev daemon on macOS has no cgroup2 at the path
 * this reads, and cgroup v1 answers neither file. A gate that refused on ignorance would refuse every turn on
 * all three, which is a far worse failure than the one it is preventing. */
test("a sandbox with no measurable ceiling admits rather than refusing on ignorance", () => {
    const unknown: MemoryHeadroom = { limitBytes: undefined, usedBytes: undefined, freeBytes: undefined, stalledPercent: 0 };
    expect(admitTurn(unknown)).toEqual({ admit: true });
    expect(admitTurn(unknown, true)).toEqual({ admit: true });
    /* INCLUDING a stalling one, which is the counter-intuitive half. Without a ceiling, memory.pressure is the
     * root cgroup's — the whole machine — so a busy laptop or a loaded CI runner would otherwise refuse every
     * turn a dev daemon was asked to take, and this suite would refuse them whenever the suite itself made the
     * machine work. A sandbox with no cap is not a sandbox running out of room. */
    expect(admitTurn({ ...unknown, stalledPercent: 95 })).toEqual({ admit: true });
});

// The reader must never throw: it runs on the hot path of every turn, and a missing file (macOS, cgroup v1)
// is the ordinary case for a dev daemon rather than a fault.
test("reading headroom degrades to an admitting verdict instead of throwing", async () => {
    const headroom = await readMemoryHeadroom();
    expect(typeof headroom.stalledPercent).toBe("number");
    expect(admitTurn(headroom)).toHaveProperty("admit");
});

// The common case pays for exactly one reading: a box with room must not brush a 5s interval against a wait
// that had nothing to wait for.
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

/* The deadline is a CAP on patience, not a veto: on exhaustion the caller runs anyway, so what this returns is
 * the refusal's wording for the caller's log line rather than a reason to drop the work. */
test("an exhausted deadline reports unadmitted with the refusal's own words, never hangs", async () => {
    const wait = await waitForMemoryHeadroom({ intervalMs: 1, deadlineMs: 3, read: () => Promise.resolve(box(10, 9.9)) });
    expect(wait.admitted).toBe(false);
    expect(wait.message).toContain("GiB");
});

// The gate holds queued work to the unattended bar: room enough for a turn is not room enough for a suite.
test("the wait is held to the unattended reserve, not the interactive one", async () => {
    const oneTurn = { ...box(10, 8.5), freeBytes: 1.5 * GIB };
    const wait = await waitForMemoryHeadroom({ intervalMs: 1, deadlineMs: 3, read: () => Promise.resolve(oneTurn) });
    expect(wait.admitted).toBe(false);
});

// An aborted caller stops waiting immediately: the suite it was queueing is being cancelled, and five more
// minutes of polling would outlive the run it was for.
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
