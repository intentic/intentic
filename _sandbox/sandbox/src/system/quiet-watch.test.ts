import { pino } from "pino";
import { startQuietWatch, type QuietProbes } from "./quiet-watch.js";

const logger = pino({ level: "silent" });

const probesOf = (over: Partial<QuietProbes>): QuietProbes => ({
    connected: () => 0,
    working: () => 0,
    terminalActivityAt: () => Promise.resolve(0),
    appsInUse: () => Promise.resolve(false),
    nextWakeAt: () => Promise.resolve(0),
    keepAwake: () => Promise.resolve(false),
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

    test("sleep switched off says so and keeps no streak, so switching it back on starts the quiet over", async () => {
        let clock = 0;
        let kept = false;
        const watch = startQuietWatch(probesOf({ keepAwake: () => Promise.resolve(kept), nextWakeAt: () => Promise.resolve(9_000_000) }), {
            logger,
            now: () => clock,
            checkMs: 1e9,
        });
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 0, nextWakeAt: 9_000_000 });
        kept = true;
        clock = 60_000;
        await watch.check();
        expect(watch.read()).toEqual({ nextWakeAt: 9_000_000, keepAwake: true });
        kept = false;
        clock = 120_000;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 120_000, nextWakeAt: 9_000_000 });
        watch.stop();
    });

    test("a switch that cannot be read lets the sandbox sleep as before", async () => {
        const watch = startQuietWatch(probesOf({ keepAwake: () => Promise.reject(new Error("unreadable")) }), { logger, now: () => 5, checkMs: 1e9 });
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 5 });
        watch.stop();
    });
});
