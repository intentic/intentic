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

test("it says how many turns run, and says it again when the count changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "work-signal-"));
    const path = join(dir, "run", "work.json");
    let live: string[] = ["a", "b"];
    let clock = 1_000;
    const signal = startWorkSignal({
        conversations: { liveSessionIds: () => live },
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
        conversations: { liveSessionIds: () => ["a"] },
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
        conversations: { liveSessionIds: () => [] },
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
