import { pino } from "pino";
import { startQuietWatch, type QuietProbes } from "./quiet-watch.js";

const logger = pino({ level: "silent" });

const probesOf = (over: Partial<QuietProbes>): QuietProbes => ({
    connected: () => 0,
    working: () => 0,
    terminalActivityAt: () => Promise.resolve(0),
    appsInUse: () => Promise.resolve(false),
    nextWakeAt: () => Promise.resolve(0),
    ...over,
});

describe("startQuietWatch", () => {
    test("a quiet sandbox reads quiet since the first pass that saw it, and a typed key moves the start forward", async () => {
        let clock = 1_000_000;
        let typedAt = 0;
        const watch = startQuietWatch(probesOf({ terminalActivityAt: () => Promise.resolve(typedAt) }), { logger, now: () => clock, checkMs: 1e9 });
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 1_000_000 });
        clock += 60_000;
        typedAt = clock - 5_000;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: clock - 5_000 });
        watch.stop();
    });

    test("anything needing the sandbox breaks the streak, and the next quiet one starts over", async () => {
        let clock = 0;
        let people = 0;
        let inUse = false;
        const watch = startQuietWatch(probesOf({ connected: () => people, appsInUse: () => Promise.resolve(inUse) }), {
            logger,
            now: () => clock,
            checkMs: 1e9,
        });
        await watch.check();
        expect(watch.read().quietSince).toBe(0);
        people = 1;
        clock = 60_000;
        await watch.check();
        expect(watch.read().quietSince).toBeUndefined();
        people = 0;
        inUse = true;
        clock = 120_000;
        await watch.check();
        expect(watch.read().quietSince).toBeUndefined();
        inUse = false;
        clock = 180_000;
        await watch.check();
        expect(watch.read().quietSince).toBe(180_000);
        watch.stop();
    });

    test("a promised wake is said whether busy or quiet, and only a change is reported", async () => {
        let busy = 1;
        const changes: number[] = [];
        const watch = startQuietWatch(probesOf({ working: () => busy, nextWakeAt: () => Promise.resolve(5_000_000) }), {
            logger,
            now: () => 1_000,
            checkMs: 1e9,
            onChange: () => changes.push(1),
        });
        await watch.check();
        await watch.check();
        expect(watch.read()).toEqual({ nextWakeAt: 5_000_000 });
        expect(changes).toHaveLength(1);
        busy = 0;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 1_000, nextWakeAt: 5_000_000 });
        expect(changes).toHaveLength(2);
        watch.stop();
    });
});
