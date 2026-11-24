import { aroundIcRun, icRunChanges, noteIcRun, sharedReading } from "./ic-readings.js";

/* One slow `ic` reading answers every caller: these hold the sharing (one read for callers who ask together), the hold
(an answer stands for its window, then is read again), and the drops (after this agent's own changing `ic` runs, a stamp
that moved, and a caller asking fresh). */

// A read whose answers are counted and released by hand, so a test decides when each lands.
const gatedRead = () => {
    let count = 0;
    const pending: (() => void)[] = [];
    return {
        read: async () => {
            count += 1;
            const mine = count;
            await new Promise<void>((resolve) => pending.push(resolve));
            return mine;
        },
        reads: () => count,
        land: () => {
            for (const release of pending.splice(0)) {
                release();
            }
        },
    };
};

const clock = () => {
    let at = 1_000_000;
    return { now: () => at, pass: (ms: number) => (at += ms) };
};

test("callers who ask while a read is in flight share it", async () => {
    const gate = gatedRead();
    const reading = sharedReading(gate.read, { heldMs: 15_000, dropOnIcChange: false });
    const asks = [reading.get(), reading.get(), reading.get()];
    await Promise.resolve();
    gate.land();
    expect(await Promise.all(asks)).toEqual([1, 1, 1]);
    expect(gate.reads()).toBe(1);
});

test("an answer stands for its hold and is read again after it", async () => {
    const time = clock();
    let count = 0;
    const reading = sharedReading(async () => (count += 1), { heldMs: 15_000, dropOnIcChange: false, now: time.now });
    expect(await reading.get()).toBe(1);
    time.pass(14_999);
    expect(await reading.get()).toBe(1);
    time.pass(1);
    expect(await reading.get()).toBe(2);
});

test("a caller asking fresh reads again, and what it read stands for the next caller", async () => {
    let count = 0;
    const reading = sharedReading(async () => (count += 1), { heldMs: 15_000, dropOnIcChange: false });
    expect(await reading.get()).toBe(1);
    expect(await reading.get({ fresh: true })).toBe(2);
    expect(await reading.get()).toBe(2);
});

test("a failed read is never held", async () => {
    let fail = true;
    const reading = sharedReading(
        async () => {
            if (fail) {
                throw new Error("docker is down");
            }
            return "rows";
        },
        { heldMs: 15_000, dropOnIcChange: false },
    );
    await expect(reading.get()).rejects.toThrow("docker is down");
    fail = false;
    expect(await reading.get()).toBe("rows");
});

test("a stamp that moved is a different reading", async () => {
    let stamp = "a";
    let count = 0;
    const reading = sharedReading(async () => (count += 1), { heldMs: 30_000, stamp: async () => stamp, dropOnIcChange: false });
    expect(await reading.get()).toBe(1);
    expect(await reading.get()).toBe(1);
    stamp = "b";
    expect(await reading.get()).toBe(2);
});

test("this agent's own changing ic run drops what is held, before it starts and once it ends", async () => {
    let count = 0;
    const reading = sharedReading(async () => (count += 1), { heldMs: 15_000 });
    expect(await reading.get()).toBe(1);
    let duringRun: number | undefined;
    await aroundIcRun(["sandbox", "stop", "work"], async () => {
        duringRun = await reading.get();
    });
    // Read again as the stop started, and again once it ended.
    expect(duringRun).toBe(2);
    expect(await reading.get()).toBe(3);
    // A failing run drops it too.
    await expect(
        aroundIcRun(["sandbox", "start", "work"], async () => {
            throw new Error("start failed");
        }),
    ).rejects.toThrow("start failed");
    expect(await reading.get()).toBe(4);
});

test("a listing in flight when an own action starts is handed to its callers but not held", async () => {
    const gate = gatedRead();
    const reading = sharedReading(gate.read, { heldMs: 15_000 });
    const early = reading.get();
    await Promise.resolve();
    noteIcRun(["sandbox", "sleep", "work"]);
    gate.land();
    expect(await early).toBe(1);
    const after = reading.get();
    await Promise.resolve();
    gate.land();
    expect(await after).toBe(2);
});

test("a read-only ic run drops nothing", async () => {
    let count = 0;
    const reading = sharedReading(async () => (count += 1), { heldMs: 15_000 });
    expect(await reading.get()).toBe(1);
    noteIcRun(["sandbox", "logs", "work", "--tail", "200"]);
    noteIcRun(["engine", "disk", "--json"]);
    noteIcRun(["sandbox", "swaps", "--json"]);
    expect(await reading.get()).toBe(1);
});

test("which ic runs change what a reading holds", () => {
    for (const changing of [
        ["sandbox", "start", "work"],
        ["sandbox", "stop", "work"],
        ["sandbox", "sleep", "--idle", "30"],
        ["sandbox", "fix", "--auto", "--json", "--source", "agent"],
        ["sandbox", "move-out", "work"],
        ["sandbox", "remove", "work", "-y"],
        ["sandbox", "egress", "work", "--set", "open"],
        ["sandbox", "watch", "--json"],
        ["engine", "disk", "--consumers", "--kept", "--relieve"],
        ["runner", "up", "https://x", "--pair", "p", "--name", "r"],
    ]) {
        expect({ changing, says: icRunChanges(changing) }).toEqual({ changing, says: true });
    }
    for (const reading of [["sandbox", "list", "--json"], ["sandbox", "swaps", "--json"], ["sandbox", "doctor", "work", "--json"], ["engine", "disk", "--json"], ["--version"]]) {
        expect({ reading, says: icRunChanges(reading) }).toEqual({ reading, says: false });
    }
});
