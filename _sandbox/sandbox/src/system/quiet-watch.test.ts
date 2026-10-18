import { pino } from "pino";
import { startQuietWatch } from "./quiet-watch.js";
import { quietProbesOf as probesOf } from "./quiet-watch.testing.js";

const logger = pino({ level: "silent" });

describe("startQuietWatch", () => {
    test("a quiet sandbox reads quiet since the first pass that saw it, and a typed key moves the start forward", async () => {
        let clock = 1_000_000;
        let typedAt = 0;
        const watch = startQuietWatch(probesOf({ terminalActivityAt: () => Promise.resolve(typedAt) }), { logger, now: () => clock, checkMs: 1e9 });
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 1_000_000, personAt: 0 });
        clock += 60_000;
        typedAt = clock - 5_000;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: clock - 5_000, personAt: clock - 5_000 });
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
        expect(watch.read()).toEqual({ nextWakeAt: 5_000_000, personAt: 0 });
        expect(changes).toHaveLength(1);
        busy = 0;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 1_000, nextWakeAt: 5_000_000, personAt: 0 });
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
        expect(watch.read()).toEqual({ quietSince: 0, nextWakeAt: 9_000_000, personAt: 0 });
        kept = true;
        clock = 60_000;
        await watch.check();
        expect(watch.read()).toEqual({ nextWakeAt: 9_000_000, personAt: 0, keepAwake: true });
        kept = false;
        clock = 120_000;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 120_000, nextWakeAt: 9_000_000, personAt: 0 });
        watch.stop();
    });

    test("a person is remembered from the last moment they were here, whether connected, typing or in an app", async () => {
        let clock = 10_000;
        let people = 0;
        let typedAt = 0;
        let inUse = false;
        const watch = startQuietWatch(
            probesOf({ connected: () => people, terminalActivityAt: () => Promise.resolve(typedAt), appsInUse: () => Promise.resolve(inUse) }),
            { logger, now: () => clock, checkMs: 1e9 },
        );
        await watch.check();
        expect(watch.read().personAt).toBe(0);
        people = 1;
        clock = 70_000;
        await watch.check();
        expect(watch.read()).toEqual({ personAt: 70_000 });
        people = 0;
        clock = 130_000;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 130_000, personAt: 70_000 });
        typedAt = 125_000;
        inUse = true;
        clock = 190_000;
        await watch.check();
        expect(watch.read()).toEqual({ personAt: 190_000 });
        watch.stop();
    });

    test("a switch that cannot be read refuses to certify sleep", async () => {
        const watch = startQuietWatch(probesOf({ keepAwake: () => Promise.reject(new Error("unreadable")) }), { logger, now: () => 5, checkMs: 1e9 });
        await expect(watch.check()).rejects.toThrow("unreadable");
        expect(watch.read()).toEqual({});
        watch.stop();
    });

    test("an unreadable clock revokes quiet, retains the known alarm, and recovery starts a fresh streak", async () => {
        let clock = 1_000;
        let failed = false;
        const watch = startQuietWatch(probesOf({ nextWakeAt: async () => {
            if (failed) { throw new Error("bookings unreadable"); }
            return 9_000_000;
        } }), { logger, now: () => clock, checkMs: 1e9 });
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 1_000, nextWakeAt: 9_000_000, personAt: 0 });
        clock = 61_000;
        failed = true;
        await expect(watch.check()).rejects.toThrow("bookings unreadable");
        expect(watch.read()).toEqual({ nextWakeAt: 9_000_000, personAt: 0 });
        failed = false;
        clock = 121_000;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 121_000, nextWakeAt: 9_000_000, personAt: 0 });
        watch.stop();
    });

    test("invalidation revokes quiet immediately and replaces an in-flight old booking before answering", async () => {
        let at = 9_000_000;
        let held: Promise<number> | undefined;
        const watch = startQuietWatch(probesOf({ nextWakeAt: () => {
            const sample = held;
            held = undefined;
            return sample ?? Promise.resolve(at);
        } }), { logger, now: () => 1_000, checkMs: 1e9 });
        await watch.check();
        const old = Promise.withResolvers<number>();
        held = old.promise;
        const checking = watch.check();
        at = 3_000_000;
        watch.invalidate();
        expect(watch.read()).toEqual({ nextWakeAt: 9_000_000, personAt: 0 });
        old.resolve(9_000_000);
        await checking;
        expect(watch.read()).toEqual({ quietSince: 1_000, nextWakeAt: 3_000_000, personAt: 0 });
        at = 0;
        watch.invalidate();
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 1_000, personAt: 0 });
        watch.stop();
    });

    test("work seen synchronously cannot reuse the previous quiet verdict", async () => {
        let busy = 0;
        const watch = startQuietWatch(probesOf({ working: () => busy }), { logger, now: () => 5, checkMs: 1e9 });
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 5, personAt: 0 });
        busy = 1;
        expect(watch.read()).toEqual({ personAt: 0 });
        watch.stop();
    });
});
