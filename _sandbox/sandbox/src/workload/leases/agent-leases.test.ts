import type { MemoryReading } from "@intentic/constants/memory-room";
import { advanceTimersByTimeAsync, realYield } from "@intentic/testing/bun";
import { type AgentLeases, leaseFor, leaseSlot, steadyHostOf } from "./agent-leases.js";
import { type Admission, createResourceBudget, hostAwareReading } from "../resource-budget.js";
import { fairOrder } from "../room-wait-queue.js";

const GIB = 1024 ** 3;

const box = (limitGib: number, residentGib: number): MemoryReading => ({
    limitBytes: limitGib * GIB,
    usedBytes: residentGib * GIB,
    swapBytes: 0,
    stallPercent: 0,
    oomKills: undefined,
});

// A clock that moves a little more than a second at every look, so every look takes a fresh reading.
const ticking = (): (() => number) => {
    let at = 0;
    return () => (at += 1_100);
};

const leasesOf = (envelopeGib: number, agents: Readonly<Record<string, number>>, learnedFrom = 20): AgentLeases => ({
    envelopeBytes: envelopeGib * GIB,
    learnedFrom,
    agents: new Map(Object.entries(agents).map(([owner, gib]) => [owner, gib * GIB])),
});

const child = (owner: string, group?: string) => ({ workload: "agentRuntime", attended: false, owner, group }) as const;
const message = (admission: Admission): string => (admission.verdict === "run" ? "" : admission.message);

test("a lease holds what every other agent turn here may still grow into; a person's turn, a runner's and a command hold none", () => {
    const held = leasesOf(1, { a: 0.25, b: 0.75, c: 1.5 });
    expect(leaseFor(child("new"), held)).toMatchObject({ costBytes: GIB, heldBytes: GIB, agents: 3 });
    expect(leaseFor(child("a"), held)).toMatchObject({ heldBytes: 0.25 * GIB, agents: 2 });
    expect(leaseFor({ workload: "agentRuntime", attended: true }, held)).toBeUndefined();
    expect(leaseFor({ ...child("new"), where: { runner: "omen-runner" } }, held)).toBeUndefined();
    expect(leaseFor({ workload: "toolchain", attended: false }, held)).toBeUndefined();
    expect(leaseFor(child("new"), undefined)).toBeUndefined();
});

// (2026-11-25) shinobi-society: sixteen subagents of two parents went in as fast as they were spawned, each runtime
// starting at ~250 MiB; what they ran then filled the sandbox. Each now holds its envelope for as long as its turn lives.
test("agent turns nobody waits on start only while every running agent's lease and their own fit beside a person's turn", async () => {
    const running: Record<string, number> = {};
    const slot = leaseSlot();
    slot.answerToLeases(() => leasesOf(1.5, running));
    // 4 GiB of other work, and each agent turn holding 0.5 GiB once the scan has seen it.
    const occupied = (): number => 4 + Object.values(running).reduce((sum, gib) => sum + gib, 0);
    const budget = createResourceBudget({ read: async () => box(16, occupied()), now: ticking(), sampleMs: 0, leases: slot.read, waitIntervalMs: 1, waitDeadlineMs: 20 });
    const started: string[] = [];
    for (let index = 1; index <= 8; index += 1) {
        const id = `sub-${String(index)}`;
        if ((await budget.admit(child(id))).verdict === "run") {
            started.push(id);
            running[id] = 0.5;
        }
    }
    // 12 GiB free at the start; each agent takes 0.5 now and may take 1.0 more: seven fit with 1.5 + 1 GiB left for one more.
    expect(started).toHaveLength(7);
    expect(message(await budget.admit({ ...child("sub-9"), wait: {} }))).toBe(
        "Sandbox memory is spoken for: 7 agent turns running here may each grow to 1.5 GiB (the heavier minutes of the last 20 agents here), so 7.0 GiB is kept for them, which leaves 1.5 GiB of the 2.5 GiB one more needs beside a person's turn. This background work waited 1 minute for room and did not start: work people send gets the room first.",
    );
    expect((await budget.snapshot()).agents).toEqual({ running: 7, envelopeBytes: 1.5 * GIB, learnedFrom: 20, heldBytes: 7 * GIB, fit: 0 });
    // One agent finishing gives its lease back, and the next goes; its reservation, retired by its lease, stays gone.
    delete running["sub-7"];
    expect((await budget.admit(child("sub-9"))).verdict).toBe("run");
    // A person's turn is judged by the box alone, as before leases.
    expect((await budget.admit({ workload: "agentRuntime", attended: true, actor: "ada" })).verdict).toBe("run");
});

test("a child's reservation stands until its lease does, never both", async () => {
    const running: Record<string, number> = {};
    const slot = leaseSlot();
    slot.answerToLeases(() => leasesOf(1.5, running));
    let resident = 4;
    const budget = createResourceBudget({ read: async () => box(16, resident), now: ticking(), sampleMs: 0, leases: slot.read });
    expect((await budget.admit(child("sub-a"))).verdict).toBe("run");
    // Admitted, not yet seen by the scan: its reservation holds its envelope.
    expect((await budget.snapshot()).agents).toMatchObject({ running: 0, heldBytes: 0, fit: Math.floor((12 - 1.5 - 1) / 1.5) });
    // Seen at 0.5 GiB: its lease holds the 1.0 it may still grow into, and its reservation no longer counts beside it.
    running["sub-a"] = 0.5;
    resident = 4.5;
    expect((await budget.snapshot()).agents).toMatchObject({ running: 1, heldBytes: GIB, fit: Math.floor((11.5 - 1 - 1) / 1.5) });
});

test("leases that cannot be read hold nothing, and agent turns are judged by the box alone", async () => {
    const slot = leaseSlot();
    slot.answerToLeases(() => {
        throw new Error("conversations not ready");
    });
    const budget = createResourceBudget({ read: async () => box(16, 13.9), now: ticking(), sampleMs: 0, leases: slot.read });
    expect((await budget.admit(child("sub-a"))).verdict).toBe("run");
    expect((await budget.snapshot()).agents).toBeUndefined();
});

test("an agent turn reads the host's last minute, not its highest moment", () => {
    const at = (seconds: number, availableGib: number) => ({
        at: seconds * 1_000,
        reading: { ...box(16, 4), host: { name: "rog", availableBytes: availableGib * GIB, totalBytes: 32 * GIB, reserveBytes: 3.2 * GIB } },
    });
    // rog on 2026-11-25: 0.4 to 6 GiB from one reading to the next; one from two minutes ago is past.
    const recent = [at(0, 9), at(70, 0.5), at(80, 0.6), at(90, 5.5), at(100, 0.4), at(110, 6)];
    expect(steadyHostOf(at(110, 6), recent).host?.availableBytes).toBe(0.6 * GIB);
    expect(steadyHostOf(at(110, 6), []).host?.availableBytes).toBe(6 * GIB);
    expect(steadyHostOf({ at: 0, reading: box(16, 4) }, recent).host).toBeUndefined();
});

test("a child that starts in a high moment of a host otherwise short waits; heavy work's view of the host is unchanged", async () => {
    let available = 0.6;
    const reading = hostAwareReading(async () => box(16, 4));
    reading.answerToHost(async () => ({ name: "rog", availableBytes: available * GIB, totalBytes: 32 * GIB, reserveBytes: 3.2 * GIB }));
    const budget = createResourceBudget({ read: reading.read, now: ticking(), sampleMs: 0 });
    for (const gib of [0.6, 0.5, 0.7]) {
        available = gib;
        await budget.snapshot(0);
    }
    available = 6;
    expect((await budget.admit(child("sub-a"))).verdict).toBe("wait");
    expect((await budget.admit({ workload: "toolchain", attended: false })).verdict).toBe("run");
});

test("held work of different groups takes turns: the n-th of every group before the (n+1)-th of any", () => {
    const held = ["a1", "a2", "a3", "b1", "c1", "a4", "b2", "x"].map((id) => ({ id, group: id === "x" ? undefined : id[0] }));
    expect(fairOrder(held, (entry) => entry.group).map((entry) => entry.id)).toEqual(["a1", "b1", "c1", "x", "a2", "b2", "a3", "a4"]);
});

describe("room for held children", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("goes to another parent's first child before a wide fan-out's second", async () => {
        let resident = 15.5;
        const budget = createResourceBudget({ read: async () => box(16, resident), sampleMs: 0, waitIntervalMs: 60_000, waitDeadlineMs: 600_000, holderCheckMs: 0 });
        const asked = (owner: string, parent: string) => budget.admit({ ...child(owner, parent), wait: {} });
        const wide = [asked("a-1", "violin"), asked("a-2", "violin"), asked("a-3", "violin")];
        await realYield();
        const other = asked("b-1", "parrot");
        await realYield();
        // Room for two children: violin's first and parrot's first.
        resident = 12;
        budget.changed();
        await advanceTimersByTimeAsync(1_000);
        expect((await wide[0])?.verdict).toBe("run");
        expect((await other).verdict).toBe("run");
        budget.stop();
    });
});
