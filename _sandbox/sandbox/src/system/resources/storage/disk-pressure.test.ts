import type { DiskPressure } from "@intentic/sandbox-contract/schemas/metrics";
import { createDiskPressureWatch, type DiskPressureDeps, pressureLevel } from "./disk-pressure.js";
import type { HistorySpace } from "./checkout-space.js";

const TOTAL = 1000;
const at = (free: number): HistorySpace => ({ freeBytes: free, totalBytes: TOTAL });

test("the level is read off the volume's free fraction, at each boundary", () => {
    expect(pressureLevel(at(150))).toBe("ok");
    expect(pressureLevel(at(149))).toBe("reaping");
    expect(pressureLevel(at(100))).toBe("reaping");
    expect(pressureLevel(at(99))).toBe("low");
    expect(pressureLevel(at(50))).toBe("low");
    expect(pressureLevel(at(49))).toBe("critical");
    // A volume that would not say its size is not known to be full.
    expect(pressureLevel({ freeBytes: 0, totalBytes: 0 })).toBe("ok");
});

test("the settings' reaping threshold moves where reaping starts, never where the owner is told", () => {
    expect(pressureLevel(at(249), 0.25)).toBe("reaping");
    expect(pressureLevel(at(250), 0.25)).toBe("ok");
    // Under the warning line it is low whatever the threshold says, and so reaped too.
    expect(pressureLevel(at(99), 0.05)).toBe("low");
    expect(pressureLevel(at(120), 0.05)).toBe("ok");
});

test("a watch reads its threshold each tick and reaps until the disk is back over it", async () => {
    let enoughAnswers: boolean[] = [];
    let space = 200;
    const watch = createDiskPressureWatch({
        read: async () => at(space),
        reapBelow: async () => 0.25,
        reap: async (enough) => {
            space += 60;
            enoughAnswers = [await enough()];
            return 1;
        },
        lastScan: async () => undefined,
        tell: async () => {},
        changed: () => {},
        logger: { info: () => {}, warn: () => {} },
        now: () => 42,
    });
    await watch.tick();
    expect(enoughAnswers).toEqual([true]);
    expect(watch.state()).toMatchObject({ level: "ok", freeBytes: 260, reaped: { bytes: 60, checkouts: 1, at: 42 } });
});

// A disk whose free space the test sets, a reap that frees what the test says, and a record of every word to the owner.
const harness = (free: number[], reaps: number[] = []) => {
    let space = free[0] ?? TOTAL;
    let reading = 0;
    const told: { level: string; state: DiskPressure }[] = [];
    let changed = 0;
    const deps: DiskPressureDeps = {
        read: async () => at(space),
        reap: async (enough) => {
            const freed = reaps.shift() ?? 0;
            space += freed;
            await enough();
            return freed > 0 ? 2 : 0;
        },
        lastScan: async () => ({
            startedAt: 0,
            finishedAt: 0,
            outcome: "complete",
            unreadable: 0,
            categories: [
                { id: "checkouts", cleanability: "none", bytes: 50, files: 1, items: [] },
                { id: "buildOutputs", cleanability: "safe", bytes: 400, files: 1, items: [] },
                { id: "logs", cleanability: "safe", bytes: 5, files: 1, items: [] },
                { id: "workspace", cleanability: "none", bytes: 90, files: 1, items: [] },
            ],
        }),
        tell: async (level, state) => void told.push({ level, state }),
        changed: () => void (changed += 1),
        logger: { info: () => {}, warn: () => {} },
        now: () => 42,
    };
    const watch = createDiskPressureWatch(deps);
    const step = async (): Promise<void> => {
        reading += 1;
        space = free[reading - 1] ?? space;
        await watch.tick();
    };
    return { watch, told, step, changes: () => changed };
};

test("short of 15% it reaps, and says what came back and what holds the most", async () => {
    const run = harness([120], [60]);
    await run.step();
    expect(run.watch.state()).toEqual({
        level: "ok",
        freeBytes: 180,
        totalBytes: TOTAL,
        measuredAt: 42,
        reaped: { bytes: 60, checkouts: 2, at: 42 },
        using: [
            { id: "buildOutputs", bytes: 400 },
            { id: "workspace", bytes: 90 },
            { id: "checkouts", bytes: 50 },
        ],
    });
    expect(run.told).toEqual([]);
});

test("the owner hears of 10% and of 5% once each, and again only after the disk had room", async () => {
    const run = harness([90, 95, 80, 40, 45, 200, 90]);
    for (let step = 0; step < 7; step += 1) {
        await run.step();
    }
    expect(run.told.map(({ level }) => level)).toEqual(["low", "critical", "low"]);
    expect(run.told[1]?.state).toMatchObject({ level: "critical", freeBytes: 40 });
    // ok → low → critical → ok → low: four moves of the level, each pushed once.
    expect(run.changes()).toBe(4);
});
