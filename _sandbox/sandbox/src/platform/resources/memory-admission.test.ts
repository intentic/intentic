import {
    admitTurn,
    createMemoryWarnings,
    headroomFrom,
    type MemoryHeadroom,
    readMemoryHeadroom,
    type TurnAdmission,
    waitForMemoryHeadroom,
} from "./memory-admission.js";

const GIB = 1024 ** 3;

// The hold's text, or "" when admitted.
const refusal = (admission: TurnAdmission): string => (admission.admit ? "" : admission.message);

// MemoryHeadroom for a box with no stall and nothing paged out unless given them.
const box = (limitGib: number, usedGib: number, stalledPercent = 0): MemoryHeadroom => ({
    limitBytes: limitGib * GIB,
    usedBytes: usedGib * GIB,
    swapBytes: 0,
    freeBytes: (limitGib - usedGib) * GIB,
    stalledPercent,
    oomKills: undefined,
});

// Headroom off a cgroup reading in GiB, on a machine with as much memory as given, or unbounded.
const headroom = (
    limitGib: number | undefined,
    residentGib: number | undefined,
    swapGib: number | undefined,
    machineGib = Number.POSITIVE_INFINITY,
) =>
    headroomFrom(
        {
            workingSetBytes: residentGib === undefined ? undefined : residentGib * GIB,
            memoryLimitBytes: limitGib === undefined ? undefined : limitGib * GIB,
            swapBytes: swapGib === undefined ? undefined : swapGib * GIB,
            memoryEvents: {},
            pressure: { cpu: undefined, memory: undefined, io: undefined },
        },
        machineGib * GIB,
    );

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
});

// Nothing retries a refused background turn, so its sentence must not promise that anything will.
test("a background refusal says the turn did not start, and promises no later run", () => {
    const refused = refusal(admitTurn({ ...box(10, 8.5), freeBytes: 1.5 * GIB }, true));
    expect(refused).toContain("This background turn did not start");
    expect(refused).not.toMatch(/will run|nothing is lost/u);
});

test("a stalled box is refused even when the byte count looks survivable", () => {
    expect(admitTurn(box(10, 3, 87)).admit).toBe(false);
    expect(refusal(admitTurn(box(10, 3, 87)))).toContain("87%");
    // Healthy readings sit at 0; the threshold must not fire on ordinary reclaim noise.
    expect(admitTurn(box(10, 3, 0)).admit).toBe(true);
    expect(admitTurn(box(10, 3, 5)).admit).toBe(true);
});

// THE INVERSION THIS READING EXISTS TO CLOSE. A sandbox may swap past its cap (`--memory-swap`), so anon pushed to swap leaves
// memory.current and lands in memory.swap.current. Reading only the first made freeBytes RISE as the box began to
// thrash — measured on a 16 GiB cap holding 12.4 resident + 6.8 swapped: 3.6 GiB reported free, every turn admitted,
// while the machine had 350 MB and was paging at 230 MB/s. Whole GiB here so the sum is exact.
test("paging out is counted as used, not as relief", () => {
    const thrashing = headroom(16, 12, 7);
    expect(thrashing.usedBytes).toBe(19 * GIB);
    expect(thrashing.freeBytes).toBe(0);
    expect(admitTurn(thrashing).admit).toBe(false);
    // The same box read as resident-only: what the gate saw before, and it admitted.
    expect(admitTurn(headroom(16, 12, 0)).admit).toBe(true);
});

test("a refusal on a paging box names the swap, since the sum can exceed the cap", () => {
    expect(refusal(admitTurn(headroom(16, 12, 7)))).toContain("12.0 GiB resident + 7.0 GiB swapped, against 16.0 GiB");
});

// The reading rides the refusal so the composer's notice can offer a raise sized against this box, rather than
// re-deriving one from prose. Resident and swapped stay apart, as the message keeps them apart.
test("a headroom refusal carries the reading it was decided on", () => {
    const refused = admitTurn(headroom(16, 12, 7));
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

// A person is told what is at stake and left to choose; the headless spelling is no use to a reader at a composer.
test("an interactive hold states the stakes rather than telling the reader to wait", () => {
    const held = refusal(admitTurn(box(10, 9.5)));
    expect(held).toContain("the system kills processes");
    expect(held).not.toMatch(/then send again|SANDBOX_MEMORY/u);
});

// Swap being unaccounted (cgroup v1, swapaccount off) must narrow nothing: it is the pre-existing reading, not a
// reason to stop measuring the ceiling that IS readable.
test("an unaccounted swap file reads as none rather than blanking the ceiling", () => {
    const unaccounted = headroom(10, 4, undefined);
    expect(unaccounted.swapBytes).toBe(0);
    expect(unaccounted.freeBytes).toBe(6 * GIB);
    expect(admitTurn(unaccounted).admit).toBe(true);
});

// An owner may cap the box past its engine, and memory the engine does not have is not headroom.
test("a cap past the engine is measured against the engine, and an uncapped box stays without an opinion", () => {
    const beyond = headroom(32, 18.5, 0, 19.5);
    expect(beyond.limitBytes).toBe(19.5 * GIB);
    expect(beyond.freeBytes).toBe(GIB);
    expect(refusal(admitTurn(beyond, true))).toContain("18.5 GiB of 19.5 GiB used");
    expect(headroom(16, 12, 0, 19.5).limitBytes).toBe(16 * GIB);
    expect(headroom(undefined, 12, 0, 19.5).limitBytes).toBeUndefined();
});

// Unknown ceiling (no cgroup, cgroup v1, hosted) admits rather than refuses on ignorance.
test("a sandbox with no measurable ceiling admits rather than refusing on ignorance", () => {
    const unknown: MemoryHeadroom = { limitBytes: undefined, usedBytes: undefined, swapBytes: 0, freeBytes: undefined, stalledPercent: 0, oomKills: undefined };
    expect(admitTurn(unknown)).toEqual({ admit: true });
    expect(admitTurn(unknown, true)).toEqual({ admit: true });
    // Stalling still admits: without a ceiling, pressure reads the whole machine's, not this sandbox's.
    expect(admitTurn({ ...unknown, stalledPercent: 95 })).toEqual({ admit: true });
});

const SHORT = box(10, 9.5);
const ROOMY = box(10, 4);
const person = (actor: string | undefined) => ({ unattended: false, actor, conversationId: undefined });
const background = { unattended: true, actor: undefined, conversationId: undefined };

// The hard stop this replaces: the same message refused press after press until the box happened to recover.
test("a person is held once on a short box, and every turn after that goes ahead", () => {
    const warnings = createMemoryWarnings();
    const first = warnings.admit(SHORT, person("ada@example.com"));
    expect(first.admit).toBe(false);
    expect(refusal(first)).toContain("9.5 GiB of 10.0 GiB");
    expect(warnings.admit(SHORT, person("ada@example.com"))).toEqual({ admit: true });
    expect(warnings.admit(box(10, 3, 87), person("ada@example.com"))).toEqual({ admit: true });
});

test("each person is told for themselves", () => {
    const warnings = createMemoryWarnings();
    warnings.admit(SHORT, person("ada@example.com"));
    expect(warnings.admit(SHORT, person("grace@example.com")).admit).toBe(false);
    expect(warnings.admit(SHORT, person("grace@example.com")).admit).toBe(true);
    // A caller the daemon could not name is one person too, not a pass for everybody.
    expect(warnings.admit(SHORT, person(undefined)).admit).toBe(false);
    expect(warnings.admit(SHORT, person(undefined)).admit).toBe(true);
});

test("a reading with room ends the spell, so the next shortage asks again", () => {
    const warnings = createMemoryWarnings();
    warnings.admit(SHORT, person("ada@example.com"));
    expect(warnings.admit(ROOMY, person("ada@example.com"))).toEqual({ admit: true });
    expect(warnings.admit(SHORT, person("ada@example.com")).admit).toBe(false);
});

// The spell is about room for a person, so a background turn that was itself refused can still be the reading that ends it.
test("room for a person ends the spell even when a background turn took the reading", () => {
    const warnings = createMemoryWarnings();
    warnings.admit(SHORT, person("ada@example.com"));
    expect(warnings.admit({ ...box(10, 8.5), freeBytes: 1.5 * GIB }, background).admit).toBe(false);
    expect(warnings.admit(SHORT, person("ada@example.com")).admit).toBe(false);
});

test("background work is refused on every short reading and warns nobody", () => {
    const warnings = createMemoryWarnings();
    expect(warnings.admit(SHORT, background).admit).toBe(false);
    expect(warnings.admit(SHORT, background).admit).toBe(false);
    expect(warnings.admit(SHORT, person(undefined)).admit).toBe(false);
    // A person going ahead does not wave background work through behind them.
    expect(warnings.admit(SHORT, background).admit).toBe(false);
});

// A burst of spawns lands before any of them shows in the cgroup, so without claims every one passes the same reading.
const spawned = (conversationId: string) => ({ unattended: true, actor: undefined, conversationId });

test("a burst of background turns on one reading admits only as many as the room holds, and says what is held", () => {
    const warnings = createMemoryWarnings(() => 0);
    const threeFree = box(16, 13);
    expect(["a", "b", "c"].map((id) => warnings.admit(threeFree, spawned(id)).admit)).toEqual([true, true, true]);
    const fourth = warnings.admit(threeFree, spawned("d"));
    expect(fourth.admit).toBe(false);
    expect(refusal(fourth)).toBe(
        "Sandbox memory is low: 13.0 GiB of 16.0 GiB used, and 1.5 GiB held for agents that just started. This background turn did not start: turns people send get the room first.",
    );
});

test("a conversation's own claim never counts against its next turn", () => {
    const warnings = createMemoryWarnings(() => 0);
    const twoFree = box(16, 14);
    expect(warnings.admit(twoFree, spawned("a")).admit).toBe(true);
    expect(warnings.admit(twoFree, spawned("a")).admit).toBe(true);
    expect(warnings.admit(twoFree, spawned("b")).admit).toBe(false);
});

test("a claim ages out after ninety seconds, once the reading itself can show what it held", () => {
    let now = 0;
    const warnings = createMemoryWarnings(() => now);
    const twoFree = box(16, 14);
    warnings.admit(twoFree, spawned("a"));
    now = 89_999;
    expect(warnings.admit(twoFree, spawned("b")).admit).toBe(false);
    now = 90_000;
    expect(warnings.admit(twoFree, spawned("b")).admit).toBe(true);
});

test("a person's admission claims its share too, so the background turn behind it sees the room it took", () => {
    const warnings = createMemoryWarnings(() => 0);
    const twoFree = box(16, 14);
    expect(warnings.admit(twoFree, { unattended: false, actor: "ada@example.com", conversationId: "chat" }).admit).toBe(true);
    expect(warnings.admit(twoFree, spawned("child")).admit).toBe(false);
});

test("two children waiting on one reading: the first claims the room and the second keeps waiting", async () => {
    const warnings = createMemoryWarnings(() => 0);
    const read = (): Promise<MemoryHeadroom> => Promise.resolve({ ...box(16, 13.6), freeBytes: 2.4 * GIB });
    const [first, second] = await Promise.all([
        warnings.waitForRoom("a", { read, intervalMs: 1, deadlineMs: 20 }),
        warnings.waitForRoom("b", { read, intervalMs: 1, deadlineMs: 20 }),
    ]);
    expect(first).toEqual({ admitted: true, waitedMs: 0 });
    expect(second.admitted).toBe(false);
    expect(second.message).toBe("Sandbox memory is low: 13.6 GiB of 16.0 GiB used, and 0.5 GiB held for agents that just started");
    // The claim the wait made is what the door then honours for that conversation.
    expect(warnings.admit({ ...box(16, 13.6), freeBytes: 2.4 * GIB }, spawned("a")).admit).toBe(true);
});

test("a waiter is told once what is short, and starts the moment the room is there", async () => {
    const warnings = createMemoryWarnings(() => 0);
    const readings = [box(10, 9.5), box(10, 9.5), box(10, 4)];
    const told: string[] = [];
    const wait = await warnings.waitForRoom("a", {
        read: () => Promise.resolve(readings.shift() ?? box(10, 4)),
        intervalMs: 1,
        onShort: (diagnosis) => told.push(diagnosis),
    });
    expect(wait.admitted).toBe(true);
    expect(told).toEqual(["Sandbox memory is low: 9.5 GiB of 10.0 GiB used"]);
});

test("the OOM killer's count rides the reading", () => {
    const reading = headroomFrom(
        {
            workingSetBytes: 4 * GIB,
            memoryLimitBytes: 16 * GIB,
            swapBytes: 0,
            memoryEvents: { oom: 3, oom_kill: 2 },
            pressure: { cpu: undefined, memory: undefined, io: undefined },
        },
        32 * GIB,
    );
    expect(reading.oomKills).toBe(2);
    expect(headroom(16, 4, 0).oomKills).toBeUndefined();
});

test("reading headroom degrades to an admitting verdict instead of throwing", async () => {
    const live = await readMemoryHeadroom();
    expect(typeof live.stalledPercent).toBe("number");
    expect(admitTurn(live)).toHaveProperty("admit");
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

// The log line is about a command, not a turn, so it carries what was short and no sentence addressed to a composer.
test("an exhausted deadline reports unadmitted with what was still short, never hangs", async () => {
    const wait = await waitForMemoryHeadroom({ intervalMs: 1, deadlineMs: 3, read: () => Promise.resolve(box(10, 9.9)) });
    expect(wait.admitted).toBe(false);
    expect(wait.message).toBe("Sandbox memory is low: 9.9 GiB of 10.0 GiB used");
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
