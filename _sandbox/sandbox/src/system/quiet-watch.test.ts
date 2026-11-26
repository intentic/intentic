import { pino } from "pino";
import { EDITOR_IDLE_MS, NO_STREAKS, type QuietPass, type QuietReading, startQuietWatch, streaksAfter } from "./quiet-watch.js";
import { quietProbesOf as probesOf } from "./quiet-watch.testing.js";

const logger = pino({ level: "silent" });

describe("startQuietWatch", () => {
    test("a quiet sandbox reads quiet since the first pass that saw it, and a typed key moves the start forward", async () => {
        let clock = 1_000_000;
        let typedAt = 0;
        const watch = startQuietWatch(probesOf({ terminalActivityAt: () => Promise.resolve(typedAt) }), { logger, now: () => clock, checkMs: 1e9 });
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 1_000_000, unattendedSince: 1_000_000, personAt: 0, activeAt: 0 });
        clock += 60_000;
        typedAt = clock - 5_000;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: clock - 5_000, unattendedSince: clock - 5_000, personAt: clock - 5_000, activeAt: clock - 5_000 });
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
        expect(watch.read()).toEqual({ nextWakeAt: 5_000_000, personAt: 0, activeAt: 0 });
        expect(changes).toHaveLength(1);
        busy = 0;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 1_000, unattendedSince: 1_000, nextWakeAt: 5_000_000, personAt: 0, activeAt: 0 });
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
        expect(watch.read()).toEqual({ quietSince: 0, unattendedSince: 0, nextWakeAt: 9_000_000, personAt: 0, activeAt: 0 });
        kept = true;
        clock = 60_000;
        await watch.check();
        expect(watch.read()).toEqual({ nextWakeAt: 9_000_000, personAt: 0, activeAt: 0, keepAwake: true });
        kept = false;
        clock = 120_000;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 120_000, unattendedSince: 120_000, nextWakeAt: 9_000_000, personAt: 0, activeAt: 0 });
        watch.stop();
    });

    test("a person is remembered from the last moment they were here, whether connected, typing or in an app", async () => {
        let clock = 10_000;
        let people = 0;
        let typedAt = 0;
        let inUse = false;
        // A person at the editor while connected, as presence.ts says of a tab on screen and touched.
        const watch = startQuietWatch(
            probesOf({
                connected: () => people,
                editorActiveAt: (at) => (people > 0 ? at : 0),
                terminalActivityAt: () => Promise.resolve(typedAt),
                appsInUse: () => Promise.resolve(inUse),
            }),
            { logger, now: () => clock, checkMs: 1e9 },
        );
        await watch.check();
        expect(watch.read().personAt).toBe(0);
        people = 1;
        clock = 70_000;
        await watch.check();
        expect(watch.read()).toEqual({ personAt: 70_000, activeAt: 70_000 });
        people = 0;
        clock = 130_000;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 130_000, unattendedSince: 130_000, personAt: 70_000, activeAt: 70_000 });
        typedAt = 125_000;
        inUse = true;
        clock = 190_000;
        await watch.check();
        expect(watch.read()).toEqual({ personAt: 190_000, activeAt: 190_000 });
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
        expect(watch.read()).toEqual({ quietSince: 1_000, unattendedSince: 1_000, nextWakeAt: 9_000_000, personAt: 0, activeAt: 0 });
        clock = 61_000;
        failed = true;
        await expect(watch.check()).rejects.toThrow("bookings unreadable");
        expect(watch.read()).toEqual({ nextWakeAt: 9_000_000, personAt: 0, activeAt: 0 });
        failed = false;
        clock = 121_000;
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 121_000, unattendedSince: 121_000, nextWakeAt: 9_000_000, personAt: 0, activeAt: 0 });
        watch.stop();
    });

    // The sleep socket's question: a pass already in flight read the bookings before it was asked, so the answer waits for
    // another pass that begins after it.
    test("a check asked while a pass is in flight is answered by a pass that began after it", async () => {
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
        const inFlight = watch.check();
        at = 3_000_000;
        const asked = watch.check();
        old.resolve(9_000_000);
        await asked;
        await inFlight;
        expect(watch.read()).toEqual({ quietSince: 1_000, unattendedSince: 1_000, nextWakeAt: 3_000_000, personAt: 0, activeAt: 0 });
        watch.stop();
    });

    test("work seen synchronously cannot reuse the previous quiet verdict", async () => {
        let busy = 0;
        const watch = startQuietWatch(probesOf({ working: () => busy }), { logger, now: () => 5, checkMs: 1e9 });
        await watch.check();
        expect(watch.read()).toEqual({ quietSince: 5, unattendedSince: 5, personAt: 0, activeAt: 0 });
        busy = 1;
        expect(watch.read()).toEqual({ personAt: 0, activeAt: 0 });
        watch.stop();
    });
});

/* AN EDITOR LEFT OPEN (2026-11-26): connected, nobody at it. The strict streak waits for it to close, as the keeper's own
   sleep reads it; the unattended one, which only the sleep for memory reads, lets it go after EDITOR_IDLE_MS. */
describe("an editor left open with nobody at it", () => {
    const MIN = 60_000;

    const setup = () => {
        const editor = { connected: 1, atIt: true, leftAt: 0 };
        let clock = 0;
        const watch = startQuietWatch(
            probesOf({ connected: () => editor.connected, editorActiveAt: (at) => (editor.connected > 0 && editor.atIt ? at : editor.leftAt) }),
            { logger, now: () => clock, checkMs: 1e9 },
        );
        const lookAt = async (minute: number): Promise<QuietReading> => {
            clock = minute * MIN;
            await watch.check();
            return watch.read();
        };
        // Somebody walks away from the editor at `minute`, leaving it open.
        const leave = (minute: number): void => {
            editor.atIt = false;
            editor.leftAt = minute * MIN;
        };
        return { editor, watch, lookAt, leave, setClock: (minute: number) => void (clock = minute * MIN) };
    };

    test("counts as somebody for half an hour after they were last at it, then the unattended streak runs from the first look after", async () => {
        const { watch, lookAt, leave } = setup();
        expect(await lookAt(0)).toEqual({ personAt: 0, activeAt: 0 });
        leave(10);
        expect(await lookAt(11)).toEqual({ personAt: 11 * MIN, activeAt: 10 * MIN });
        expect((await lookAt(10 + EDITOR_IDLE_MS / MIN - 1)).unattendedSince).toBeUndefined();
        const left = await lookAt(10 + EDITOR_IDLE_MS / MIN);
        // Still connected, so still a person seen at this very look.
        expect(left).toEqual({ unattendedSince: 11 * MIN, personAt: 40 * MIN, activeAt: 10 * MIN });
        // The strict streak never comes while it stays connected: the keeper's own sleep waits for it to close.
        expect((await lookAt(600)).quietSince).toBeUndefined();
        expect((await lookAt(600)).unattendedSince).toBe(11 * MIN);
        watch.stop();
    });

    test("somebody back at it withdraws the unattended streak at once, before the next look, and starts it over", async () => {
        const { editor, watch, lookAt, leave, setClock } = setup();
        await lookAt(0);
        leave(1);
        await lookAt(2);
        expect((await lookAt(40)).unattendedSince).toBe(2 * MIN);
        editor.atIt = true;
        setClock(41);
        expect(watch.read().unattendedSince).toBeUndefined();
        expect(await lookAt(41)).toEqual({ personAt: 41 * MIN, activeAt: 41 * MIN });
        leave(45);
        await lookAt(46);
        expect((await lookAt(46 + EDITOR_IDLE_MS / MIN)).unattendedSince).toBe(46 * MIN);
        watch.stop();
    });

    test("closed at last: quiet from the close, unattended still from when it was left", async () => {
        const { editor, watch, lookAt, leave } = setup();
        await lookAt(0);
        leave(5);
        await lookAt(6);
        editor.connected = 0;
        expect(await lookAt(100)).toEqual({ quietSince: 100 * MIN, unattendedSince: 6 * MIN, personAt: 6 * MIN, activeAt: 5 * MIN });
        watch.stop();
    });
});

describe("streaksAfter", () => {
    const pass = (over: Partial<QuietPass> = {}): QuietPass => ({ at: 1_000, kept: false, needed: false, connected: false, attended: false, typedAt: 0, ...over });

    test("kept awake or needed: neither streak, and none certified", () => {
        expect(streaksAfter(pass({ kept: true }), { quiet: 5, unattended: 5 }, 0)).toEqual({ streaks: NO_STREAKS, certified: {} });
        expect(streaksAfter(pass({ needed: true }), { quiet: 5, unattended: 5 }, 0)).toEqual({ streaks: NO_STREAKS, certified: {} });
    });

    test("a connection breaks the strict streak only; somebody at it within the half hour holds the other back unbroken", () => {
        expect(streaksAfter(pass({ connected: true }), { quiet: 5, unattended: 5 }, 0)).toEqual({ streaks: { quiet: undefined, unattended: 5 }, certified: { unattendedSince: 5 } });
        expect(streaksAfter(pass({ connected: true, attended: true }), { quiet: 5, unattended: 5 }, 0)).toEqual({ streaks: { quiet: undefined, unattended: 5 }, certified: {} });
    });

    test("each streak starts at the first pass that sees it, typing moves the strict one, any activity the other", () => {
        expect(streaksAfter(pass(), NO_STREAKS, 0)).toEqual({ streaks: { quiet: 1_000, unattended: 1_000 }, certified: { quietSince: 1_000, unattendedSince: 1_000 } });
        expect(streaksAfter(pass({ typedAt: 1_500 }), { quiet: 900, unattended: 900 }, 1_700).certified).toEqual({ quietSince: 1_500, unattendedSince: 1_700 });
    });
});
