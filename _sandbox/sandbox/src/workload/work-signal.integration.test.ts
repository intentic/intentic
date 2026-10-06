import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkSignal, workSignalBody } from "./work-signal.js";

// The file the host's keeper reads before it restarts a sandbox: the count it says must be the count that runs now.

const quietEvents = { subscribe: () => () => undefined };
const quietLogger = { warn: () => undefined };

test("the body is one JSON line ic reads with serde", () => {
    expect(workSignalBody(2, 5)).toBe('{"liveTurns":2,"at":5}\n');
});

// 2026-10-05: the keeper sees a restart storm as the daemon does, from the same facts, beside the fields it already reads.
test("the body says when this boot was, the boot before, and whether they made a storm, after the fields ic reads", () => {
    const body = workSignalBody(1, 9, { bootedAt: 8, previousBootAt: 4, bootsInWindow: 3, storm: true, restartAskedAt: 3 });
    expect(JSON.parse(body)).toEqual({ liveTurns: 1, at: 9, bootedAt: 8, previousBootAt: 4, bootsInWindow: 3, restartStorm: true, lastRestartAt: 3 });
    expect(body.startsWith('{"liveTurns":1,"at":9,')).toBe(true);
    expect(JSON.parse(workSignalBody(0, 9, { bootedAt: 8, bootsInWindow: 1, storm: false }))).toEqual({
        liveTurns: 0,
        at: 9,
        bootedAt: 8,
        bootsInWindow: 1,
        restartStorm: false,
    });
});

test("a signal handed the boot's facts writes them with every count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "work-signal-"));
    const path = join(dir, "work.json");
    const signal = startWorkSignal({
        working: () => 0,
        events: quietEvents,
        logger: quietLogger,
        boot: async () => ({ bootedAt: 700, bootsInWindow: 1, storm: false }),
        path,
        now: () => 1_000,
    });
    try {
        await signal.tick();
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ liveTurns: 0, at: 1_000, bootedAt: 700, bootsInWindow: 1, restartStorm: false });
    } finally {
        signal.stop();
        await rm(dir, { recursive: true, force: true });
    }
});

test("it says how many turns run, and says it again when the count changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "work-signal-"));
    const path = join(dir, "run", "work.json");
    let live: string[] = ["a", "b"];
    let clock = 1_000;
    const signal = startWorkSignal({
        working: () => live.length,
        events: quietEvents,
        logger: quietLogger,
        path,
        now: () => clock,
    });
    try {
        await signal.tick();
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ liveTurns: 2, at: 1_000 });
        live = [];
        clock = 2_000;
        await signal.tick();
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ liveTurns: 0, at: 2_000 });
    } finally {
        signal.stop();
        await rm(dir, { recursive: true, force: true });
    }
});

test("an unchanged count is rewritten only once its stamp is a minute old, so `at` tells live from left behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "work-signal-"));
    const path = join(dir, "work.json");
    let clock = 1_000;
    const signal = startWorkSignal({
        working: () => 1,
        events: quietEvents,
        logger: quietLogger,
        path,
        now: () => clock,
    });
    try {
        await signal.tick();
        clock = 30_000;
        await signal.tick();
        expect(JSON.parse(await readFile(path, "utf8")).at).toBe(1_000);
        clock = 61_000;
        await signal.tick();
        expect(JSON.parse(await readFile(path, "utf8")).at).toBe(61_000);
    } finally {
        signal.stop();
        await rm(dir, { recursive: true, force: true });
    }
});

test("a daemon with nowhere to write says so once, and keeps running", async () => {
    const warnings: unknown[] = [];
    const signal = startWorkSignal({
        working: () => 0,
        events: quietEvents,
        logger: { warn: (...args: unknown[]) => void warnings.push(args) },
        path: "/proc/no-such-dir/work.json",
        now: (() => {
            let clock = 0;
            return () => (clock += 120_000);
        })(),
    });
    await signal.tick();
    await signal.tick();
    signal.stop();
    expect(warnings).toHaveLength(1);
});

// Writes are chained so a stale count never lands after a fresher one; a tick that threw must not leave that chain
// rejected, or the host would read the last count before it forever.
test("a tick that throws loses only itself: the next one still writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "work-signal-"));
    const path = join(dir, "work.json");
    let asked = 0;
    const signal = startWorkSignal({
        working: () => {
            asked += 1;
            if (asked === 2) {
                throw new Error("registry mid-swap");
            }
            return asked === 1 ? 1 : 2;
        },
        events: quietEvents,
        logger: quietLogger,
        path,
        now: () => 1_000,
    });
    try {
        await expect(signal.tick()).rejects.toThrow("registry mid-swap");
        await signal.tick();
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ liveTurns: 2, at: 1_000 });
    } finally {
        signal.stop();
        await rm(dir, { recursive: true, force: true });
    }
});
