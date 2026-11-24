import { WORKSPACE_ROOT } from "@intentic/constants";
import type { BudgetSnapshot } from "../workload/resource-budget.js";
import { FACTS_FRESH_MS, type FactsHub, refreshRunnerFacts } from "./fleet-facts.js";
import { machineFacts, parseGpuQuery } from "./machine-facts.js";

// A runner's facts are its hello's until someone asks again. What compares machines asks here: only the online ones,
// at most once per freshness window, and one ask per runner however many callers want it at once.

const hubOf = (online: readonly string[]) => {
    const asked: string[] = [];
    const hub: FactsHub = {
        // SAFETY: a refresh only asks whether a client exists; it never calls one.
        client: (id) => (online.includes(id) ? ({} as never) : undefined),
        refresh: async (id) => {
            asked.push(id);
        },
    };
    return { hub, asked };
};

test("asks only the runners that are connected", async () => {
    const { hub, asked } = hubOf(["omen"]);
    await refreshRunnerFacts(hub, ["omen", "asleep"], () => 1_000_000);
    expect(asked).toEqual(["omen"]);
});

test("asks again only once the last answer has gone stale", async () => {
    const { hub, asked } = hubOf(["omen"]);
    let now = 1_000_000;
    await refreshRunnerFacts(hub, ["omen"], () => now);
    now += FACTS_FRESH_MS - 1;
    await refreshRunnerFacts(hub, ["omen"], () => now);
    expect(asked).toEqual(["omen"]);
    now += 1;
    await refreshRunnerFacts(hub, ["omen"], () => now);
    expect(asked).toEqual(["omen", "omen"]);
});

test("callers asking at once share one question to the runner", async () => {
    const { hub, asked } = hubOf(["omen"]);
    await Promise.all([refreshRunnerFacts(hub, ["omen"], () => 1_000_000), refreshRunnerFacts(hub, ["omen"], () => 1_000_000)]);
    expect(asked).toEqual(["omen"]);
});

const GIB = 1024 ** 3;
const snapshot = (freeBytes: number | undefined, limitBytes: number | undefined, stallPercent = 0): BudgetSnapshot => ({
    at: 0,
    reading: { limitBytes, usedBytes: undefined, swapBytes: 0, stallPercent, oomKills: undefined },
    reservedBytes: 0,
    freeBytes,
    personNeedBytes: GIB,
    stallLimitPercent: 20,
    stallSustainedLimitPercent: 10,
});

// The same ruler on both ends of the link: the budget's free figure, its limit, and the PSI readings.
test("a machine is measured by its own budget and pressure, with its load over its cores", async () => {
    const facts = await machineFacts(WORKSPACE_ROOT, {
        budget: { snapshot: async () => snapshot(6 * GIB, 16 * GIB, 3) },
        pressure: async () => ({ cpu: { some: 42, full: 0 }, memory: undefined, io: undefined }),
        os: () => ({ cores: 8, totalMemoryBytes: 64 * GIB, loadOne: 4 }),
        disk: async () => ({ freeBytes: 10 * GIB }),
        gpus: async () => [{ name: "NVIDIA GeForce RTX 3080 Laptop GPU", memoryMb: 16_384 }],
    });
    expect(facts).toEqual({
        cpus: 8,
        memoryMb: 65_536,
        freeDiskMb: 10_240,
        load: 0.5,
        memoryFreeMb: 6_144,
        memoryLimitMb: 16_384,
        memoryStall: 3,
        cpuPressure: 42,
        gpus: [{ name: "NVIDIA GeForce RTX 3080 Laptop GPU", memoryMb: 16_384 }],
    });
});

// What nvidia-smi's csv query answers, by name and memory; a name with commas of its own keeps them.
test("a machine's GPUs are read off nvidia-smi's answer", () => {
    expect(parseGpuQuery("NVIDIA GeForce RTX 5080 Laptop GPU, 16303\nTesla, Inc. X, 8192\n")).toEqual([
        { name: "NVIDIA GeForce RTX 5080 Laptop GPU", memoryMb: 16_303 },
        { name: "Tesla, Inc. X", memoryMb: 8_192 },
    ]);
});

// The budget carries what this sandbox's host last said: a VM with room on a Windows that has none is not a machine with
// room, and what was admitted a moment ago is not in the host's figure yet either.
test("a machine's free memory never exceeds what its host has above its reserve", async () => {
    const measured = (host: { availableBytes: number; totalBytes: number; reserveBytes: number }, reservedBytes = 0) =>
        machineFacts(WORKSPACE_ROOT, {
            budget: {
                snapshot: async () => {
                    const base = snapshot(12 * GIB, 22 * GIB);
                    return { ...base, reading: { ...base.reading, host: { name: "omen", ...host } }, reservedBytes };
                },
            },
            pressure: async () => ({ cpu: undefined, memory: undefined, io: undefined }),
            os: () => ({ cores: 16, totalMemoryBytes: 26 * GIB, loadOne: 1 }),
            disk: async () => ({ freeBytes: 10 * GIB }),
            gpus: async () => [],
        });
    const windows = { totalBytes: 32 * GIB, reserveBytes: 3.2 * GIB };
    expect((await measured({ ...windows, availableBytes: 2 * GIB })).memoryFreeMb).toBe(0);
    expect((await measured({ ...windows, availableBytes: 7.2 * GIB })).memoryFreeMb).toBe(4_096);
    expect((await measured({ ...windows, availableBytes: 7.2 * GIB }, GIB)).memoryFreeMb).toBe(3_072);
    // A host with more room than the budget leaves the budget's own figure.
    expect((await measured({ ...windows, availableBytes: 30 * GIB })).memoryFreeMb).toBe(12_288);
});

test("what a machine cannot measure is left out, never reported as zero", async () => {
    const facts = await machineFacts(WORKSPACE_ROOT, {
        budget: { snapshot: async () => snapshot(undefined, undefined) },
        pressure: async () => {
            throw new Error("no PSI on this kernel");
        },
        os: () => ({ cores: 4, totalMemoryBytes: 8 * GIB, loadOne: 1 }),
        disk: async () => undefined,
        gpus: async () => [],
    });
    expect(facts).toEqual({ cpus: 4, memoryMb: 8_192, freeDiskMb: 0, load: 0.25, memoryStall: 0, gpus: [] });
});
