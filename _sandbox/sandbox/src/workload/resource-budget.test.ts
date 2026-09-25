import { askRoom, type MemoryReading } from "@intentic/constants/memory-room";
import { type Admission, type AdmitRequest, createResourceBudget, type ResourceBudget, WORKLOAD_COST_BYTES } from "./resource-budget.js";

const GIB = 1024 ** 3;

// A box of `limitGib` with `residentGib` resident and `swapGib` swapped, as the formula reads it.
const box = (limitGib: number, residentGib: number, stallPercent = 0, swapGib = 0): MemoryReading => ({
    limitBytes: limitGib * GIB,
    usedBytes: (residentGib + swapGib) * GIB,
    swapBytes: swapGib * GIB,
    stallPercent,
    oomKills: undefined,
});

// A clock that moves a little more than a second at every look, so every look takes a fresh reading.
const ticking = (): (() => number) => {
    let at = 0;
    return () => (at += 1_100);
};

// The budget on a stated reading, changed by the test as it goes, on a clock that ticks or one the test moves.
const budgetOf = (reading: () => MemoryReading, now: () => number = ticking()): ResourceBudget =>
    createResourceBudget({ read: async () => reading(), now, sampleMs: 0, waitIntervalMs: 1, waitDeadlineMs: 20 });

const message = (admission: Admission): string => (admission.verdict === "run" ? "" : admission.message);

const person = (actor: string | undefined): AdmitRequest => ({ workload: "agentRuntime", attended: true, actor });
const background = (owner?: string): AdmitRequest => ({ workload: "agentRuntime", attended: false, owner });

test("a turn needs its runtime's cost free; work nobody waits on needs a person's turn on top", async () => {
    expect(WORKLOAD_COST_BYTES.agentRuntime).toBe(GIB);
    expect((await budgetOf(() => box(10, 9)).admit(person("ada"))).verdict).toBe("run");
    expect((await budgetOf(() => box(10, 9.01)).admit(person("ada"))).verdict).toBe("refuse");
    expect((await budgetOf(() => box(10, 8)).admit(background())).verdict).toBe("run");
    expect((await budgetOf(() => box(10, 8.01)).admit(background())).verdict).toBe("wait");
});

test("a person on a short box is told what is used and what is at stake", async () => {
    expect(message(await budgetOf(() => box(10, 9.5)).admit(person("ada")))).toBe(
        "Sandbox memory is low: 9.5 GiB of 10.0 GiB used. Starting another agent now can slow the running ones down, and if memory runs out, the system kills processes to free it.",
    );
});

// The reading rides the refusal so the composer's notice can offer a raise sized against this box.
test("a refusal on a paging box names the swap and carries the reading it was decided on", async () => {
    const refused = await budgetOf(() => box(16, 12, 0, 7)).admit(person("ada"));
    expect(refused).toEqual({
        verdict: "refuse",
        message:
            "Sandbox memory is low: 12.0 GiB resident + 7.0 GiB swapped, against 16.0 GiB. Starting another agent now can slow the running ones down, and if memory runs out, the system kills processes to free it.",
        memory: { limitBytes: 16 * GIB, residentBytes: 12 * GIB, swapBytes: 7 * GIB },
        waitedMs: 0,
    });
});

test("a stalled box is short whatever its byte count, and a stall refusal carries no reading to raise", async () => {
    const stalled = await budgetOf(() => box(10, 3, 87)).admit(person("ada"));
    expect(stalled).toEqual({
        verdict: "refuse",
        message:
            "The sandbox is short of memory: for 87% of the last ten seconds, everything in it was waiting on memory. Starting another agent now can slow the running ones down, and if memory runs out, the system kills processes to free it.",
        waitedMs: 0,
    });
    expect((await budgetOf(() => box(10, 3, 19.9)).admit(person("ada"))).verdict).toBe("run");
});

test("a sandbox nothing measures has no opinion, and runs", async () => {
    const unknown: MemoryReading = { limitBytes: undefined, usedBytes: undefined, swapBytes: 0, stallPercent: 95, oomKills: undefined };
    expect(await budgetOf(() => unknown).admit(background())).toEqual({ verdict: "run", waitedMs: 0 });
});

// The hard stop this replaced: the same message refused press after press until the box happened to recover.
test("a person is held once on a short box, and every turn after that goes ahead", async () => {
    const budget = budgetOf(() => box(10, 9.5));
    expect((await budget.admit(person("ada"))).verdict).toBe("refuse");
    expect((await budget.admit(person("ada"))).verdict).toBe("run");
    // Each person is told for themselves, and a caller the daemon could not name is one person too.
    expect((await budget.admit(person("grace"))).verdict).toBe("refuse");
    expect((await budget.admit(person(undefined))).verdict).toBe("refuse");
    expect((await budget.admit(person(undefined))).verdict).toBe("run");
});

test("a reading with room for a person ends the spell, so the next shortage asks again", async () => {
    let reading = box(10, 9.5);
    let now = 0;
    const budget = budgetOf(
        () => reading,
        () => now,
    );
    expect((await budget.admit(person("ada"))).verdict).toBe("refuse");
    reading = box(10, 4);
    now = 100_000;
    expect((await budget.admit(person("ada"))).verdict).toBe("run");
    reading = box(10, 9.5);
    now = 300_000;
    expect((await budget.admit(person("ada"))).verdict).toBe("refuse");
});

test("work nobody waits on is answered `wait` when it asks no wait, and never warns anybody", async () => {
    const budget = budgetOf(() => box(10, 9.5));
    expect(await budget.admit(background())).toEqual({ verdict: "wait", message: "Sandbox memory is low: 9.5 GiB of 10.0 GiB used", waitedMs: 0 });
    // A person going ahead does not wave background work through behind them.
    await budget.admit(person("ada"));
    await budget.admit(person("ada"));
    expect((await budget.admit(background())).verdict).toBe("wait");
});

// A burst of spawns lands before any of them shows in the cgroup, so without the ledger every one passes the same reading.
test("a burst of background work on one reading admits only as many as the room holds, and says what is held", async () => {
    const budget = budgetOf(() => box(16, 12.5));
    expect(await Promise.all(["a", "b"].map(async (id) => (await budget.admit(background(id))).verdict))).toEqual(["run", "run"]);
    expect(await budget.admit(background("c"))).toEqual({
        verdict: "wait",
        message: "Sandbox memory is low: 12.5 GiB of 16.0 GiB used, and 2.0 GiB held for work that just started",
        waitedMs: 0,
    });
    expect((await budget.snapshot()).reservedBytes).toBe(2 * GIB);
});

test("an owner's own reservation never counts against it, and a reservation ages out after ninety seconds", async () => {
    let now = 0;
    const budget = budgetOf(
        () => box(16, 13),
        () => now,
    );
    expect((await budget.admit(background("a"))).verdict).toBe("run");
    expect((await budget.admit(background("a"))).verdict).toBe("run");
    now = 89_999;
    expect((await budget.admit(background("b"))).verdict).toBe("wait");
    now = 90_000;
    expect((await budget.admit(background("b"))).verdict).toBe("run");
});

test("work sent to a runner holds nothing here and is never held for this sandbox's room", async () => {
    const budget = budgetOf(() => box(10, 9.9));
    expect(await budget.admit({ ...background("child"), where: { runner: "rig" } })).toEqual({ verdict: "run", waitedMs: 0 });
    expect((await budget.snapshot()).reservedBytes).toBe(0);
    expect((await budget.admit(person("ada"))).verdict).toBe("refuse");
});

test("held work is told once what is short, and starts the moment the room is there", async () => {
    const readings = [box(10, 9.5), box(10, 9.5), box(10, 4)];
    let now = 0;
    const budget = createResourceBudget({ read: async () => readings.shift() ?? box(10, 4), now: () => (now += 2_000), sampleMs: 0, waitIntervalMs: 1 });
    const told: string[] = [];
    const admitted = await budget.admit({ ...background("a"), wait: { onShort: (diagnosis) => told.push(diagnosis) } });
    expect(admitted.verdict).toBe("run");
    // Two short readings looked at, then the one with room: it started on the first look that had room.
    expect(readings).toEqual([]);
    expect(told).toEqual(["Sandbox memory is low: 9.5 GiB of 10.0 GiB used"]);
});

test("held work that waits out its deadline is turned away with what was still short, and says it did not start", async () => {
    const turnedAway = await budgetOf(() => box(10, 9.9)).admit({ ...background("a"), wait: {} });
    expect(turnedAway.verdict).toBe("refuse");
    expect(message(turnedAway)).toBe(
        "Sandbox memory is low: 9.9 GiB of 10.0 GiB used. This background work waited 1 minute for room and did not start: work people send gets the room first.",
    );
});

test("an abort ends a wait without its deadline", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const budget = createResourceBudget({ read: async () => box(10, 9.9), sampleMs: 0, waitIntervalMs: 60_000, waitDeadlineMs: 600_000 });
    expect((await budget.admit({ ...background("a"), wait: { signal: controller.signal } })).verdict).toBe("refuse");
});

// A child admitted while it waited as `pending` is admitted: the door that plans its turn must not judge it again on a
// fresh reading and turn it away after all.
test("work admitted for a turn is not judged a second time at the door, and only once", async () => {
    let reading = box(16, 13);
    const budget = budgetOf(() => reading);
    expect((await budget.admit({ ...background("child"), forTurn: true, wait: {} })).verdict).toBe("run");
    // The box fills between the child's admission and its door; a fresh judgement would hold it.
    reading = box(16, 15.5);
    expect(await budget.admit(background("child"))).toEqual({ verdict: "run", waitedMs: 0 });
    // The kept admission is taken once: a second turn of the same child is judged like anything else.
    expect((await budget.admit(background("child"))).verdict).toBe("wait");
});

test("two children waiting on one reading: the first takes the room and the second keeps waiting", async () => {
    const budget = budgetOf(() => box(16, 13.5));
    const [first, second] = await Promise.all([budget.admit({ ...background("a"), wait: {} }), budget.admit({ ...background("b"), wait: {} })]);
    expect(first).toEqual({ verdict: "run", waitedMs: 0 });
    expect(second.verdict).toBe("refuse");
});

test("a death certificate reads what the sampler saw in the last few minutes, not a verdict taken now", async () => {
    let reading = box(10, 9.9);
    let now = 0;
    const budget = budgetOf(
        () => reading,
        () => now,
    );
    await budget.snapshot();
    reading = box(10, 2);
    now = 60_000;
    expect(await budget.shortRecently()).toBe(true);
    now = 400_000;
    expect(await budget.shortRecently()).toBe(false);
});

// Where no daemon answers (CI, a plain checkout), the scripts apply the same formula; it must give the same verdict.
test.each([
    ["roomy", box(16, 4)],
    ["short", box(16, 14.5)],
    ["paging", box(16, 10, 0, 5)],
    ["stalled", box(16, 4, 50)],
    ["unmeasured", { limitBytes: undefined, usedBytes: undefined, swapBytes: 0, stallPercent: 0, oomKills: undefined }],
] as const)("the fallback formula gives the daemon's verdict on a %s box", async (_case, reading) => {
    const daemon = await budgetOf(() => reading).admit({ workload: "toolchain", attended: false });
    const fallback = await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath: "/nonexistent/room.sock", read: () => reading });
    expect(fallback.source).toBe("formula");
    expect(fallback.verdict).toBe(daemon.verdict);
});
