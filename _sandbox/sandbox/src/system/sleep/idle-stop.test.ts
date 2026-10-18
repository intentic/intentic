import { pino } from "pino";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { freshestPersonActivity, startIdleStop, type IdleStopProbes } from "./idle-stop.js";

const logger = pino({ level: "silent" });

const probesOf = (over: Partial<IdleStopProbes>): IdleStopProbes => ({
    connected: () => 0,
    working: () => 0,
    terminalActivityAt: () => Promise.resolve(0),
    nextPromisedWakeAt: () => Promise.resolve(0),
    ...over,
});

// The interval is a minute, so advancing N minutes runs N checks.
const minutes = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
        await advanceTimersByTimeAsync(60 * 1000);
    }
};

describe("startIdleStop", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it("stops after the quiet window when nothing is connected or running", async () => {
        const stop = jest.fn();
        const dispose = startIdleStop({ minutes: 5, logger }, probesOf({}), stop);
        await minutes(4);
        expect(stop).not.toHaveBeenCalled();
        await minutes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    it("a connected tab resets the streak: even an idle one counts as a person", async () => {
        const stop = jest.fn();
        let connected = 1;
        const dispose = startIdleStop({ minutes: 3, logger }, probesOf({ connected: () => connected }), stop);
        await minutes(10);
        expect(stop).not.toHaveBeenCalled();
        connected = 0;
        await minutes(2);
        expect(stop).not.toHaveBeenCalled();
        await minutes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    it("an in-flight turn or live delegate keeps the machine up with nobody connected", async () => {
        const stop = jest.fn();
        let turns = 1;
        const dispose = startIdleStop({ minutes: 2, logger }, probesOf({ working: () => turns }), stop);
        await minutes(6);
        expect(stop).not.toHaveBeenCalled();
        turns = 0;
        await minutes(2);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    it("an armed condition watch keeps the machine up: stopping it is how a watch never fires", async () => {
        const stop = jest.fn();
        let watchers = 1;
        const dispose = startIdleStop({ minutes: 2, logger }, probesOf({ working: () => watchers }), stop);
        await minutes(6);
        expect(stop).not.toHaveBeenCalled();
        watchers = 0;
        await minutes(2);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    it("a wake due inside the window keeps the machine up through its deadline", async () => {
        const stop = jest.fn();
        // Due in three minutes, inside a five-minute window: stopping now is how that wake arrives late.
        const dueAt = Date.now() + 3 * 60 * 1000;
        const dispose = startIdleStop({ minutes: 5, logger }, probesOf({ nextPromisedWakeAt: () => Promise.resolve(dueAt) }), stop);
        await minutes(6);
        expect(stop).not.toHaveBeenCalled();
        dispose();
    });

    it("a distant wake without an external alarm keeps the machine up", async () => {
        const stop = jest.fn();
        const dispose = startIdleStop(
            { minutes: 5, logger },
            probesOf({ nextPromisedWakeAt: () => Promise.resolve(Date.now() + 6 * 3_600_000) }),
            stop,
        );
        await minutes(5);
        expect(stop).toHaveBeenCalledTimes(0);
        dispose();
    });

    it("stops only after its distant deadline has been acknowledged outside the machine", async () => {
        const stop = jest.fn();
        const at = Date.now() + 6 * 3_600_000;
        let acknowledged = false;
        const prepareSleep = jest.fn(async () => acknowledged);
        const dispose = startIdleStop({ minutes: 5, logger }, probesOf({
            nextPromisedWakeAt: async () => at, prepareSleep,
        }), stop);
        await minutes(5);
        expect(prepareSleep).toHaveBeenCalledWith(at, 0);
        expect(stop).toHaveBeenCalledTimes(0);
        acknowledged = true;
        await minutes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    it.each(["retimed", "cancelled", "work", "terminal"])("rechecks a %s change while registering the alarm", async (change) => {
        const stop = jest.fn();
        let at = Date.now() + 6 * 3_600_000;
        let work = 0;
        let typed = 0;
        const saved = Promise.withResolvers<boolean>();
        const prepareSleep = jest.fn(() => saved.promise);
        const cancelSleep = jest.fn(async () => true);
        const dispose = startIdleStop({ minutes: 1, logger }, probesOf({
            nextPromisedWakeAt: async () => at,
            working: () => work, terminalActivityAt: async () => typed, prepareSleep, cancelSleep,
        }), stop);
        await minutes(1);
        expect(prepareSleep).toHaveBeenCalledTimes(1);
        if (change === "retimed") { at += 60_000; }
        if (change === "cancelled") { at = 0; }
        if (change === "work") { work = 1; }
        if (change === "terminal") { typed = Date.now(); }
        saved.resolve(true);
        await advanceTimersByTimeAsync(0);
        expect(stop).toHaveBeenCalledTimes(0);
        expect(cancelSleep).toHaveBeenCalledTimes(1);
        dispose();
    });

    it("retracts the alarm and stays awake if the final clock read fails", async () => {
        const stop = jest.fn();
        const cancelSleep = jest.fn(async () => true);
        let failed = false;
        const dispose = startIdleStop({ minutes: 1, logger }, probesOf({
            nextPromisedWakeAt: async () => {
                if (failed) { throw new Error("unreadable"); }
                return Date.now() + 6 * 3_600_000;
            },
            prepareSleep: async () => { failed = true; return true; },
            cancelSleep,
        }), stop);
        await minutes(1);
        expect(stop).not.toHaveBeenCalled();
        expect(cancelSleep).toHaveBeenCalledTimes(1);
        dispose();
    });

    it("serializes slow checks and cannot stop after disposal", async () => {
        const stop = jest.fn();
        const saved = Promise.withResolvers<boolean>();
        const prepareSleep = jest.fn(() => saved.promise);
        const at = Date.now() + 6 * 3_600_000;
        const dispose = startIdleStop({ minutes: 1, logger }, probesOf({ prepareSleep, nextPromisedWakeAt: async () => at }), stop);
        await minutes(5);
        expect(prepareSleep).toHaveBeenCalledTimes(1);
        dispose();
        saved.resolve(true);
        await advanceTimersByTimeAsync(0);
        expect(stop).toHaveBeenCalledTimes(0);
    });

    it("nothing due stops without waiting on the platform: an unanswered retraction cannot hold the machine up", async () => {
        const stop = jest.fn();
        const cancelSleep = jest.fn(async () => false);
        const prepareSleep = jest.fn(async () => false);
        const dispose = startIdleStop({ minutes: 5, logger }, probesOf({ prepareSleep, cancelSleep }), stop);
        await minutes(5);
        expect(cancelSleep).toHaveBeenCalledTimes(1);
        expect(prepareSleep).not.toHaveBeenCalled();
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    it("a deadline further off than a sleep is worth is armed rather than held awake for", async () => {
        const held = jest.fn();
        const soon = Date.now() + 6 * 60_000;
        const disposeSoon = startIdleStop({ minutes: 20, logger }, probesOf({ nextPromisedWakeAt: async () => soon, prepareSleep: async () => true }), held);
        await minutes(6);
        expect(held).not.toHaveBeenCalled();
        disposeSoon();
        const stop = jest.fn();
        const later = Date.now() + 30 * 60_000;
        const prepareSleep = jest.fn(async () => true);
        const dispose = startIdleStop({ minutes: 20, logger }, probesOf({ nextPromisedWakeAt: async () => later, prepareSleep }), stop);
        await minutes(20);
        expect(prepareSleep).toHaveBeenCalledWith(later, 0);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    describe("an alarm's boot", () => {
        const alarmBoot = () => true;

        it("sleeps again after the short grace when nobody came", async () => {
            const stop = jest.fn();
            const dispose = startIdleStop({ minutes: 20, logger }, probesOf({ alarmBoot }), stop);
            await minutes(4);
            expect(stop).not.toHaveBeenCalled();
            await minutes(1);
            expect(stop).toHaveBeenCalledTimes(1);
            dispose();
        });

        it("waits for the run it woke for, and every watch it armed, before the grace begins", async () => {
            const stop = jest.fn();
            let work = 1;
            const dispose = startIdleStop({ minutes: 20, logger }, probesOf({ alarmBoot, working: () => work }), stop);
            await minutes(30);
            expect(stop).not.toHaveBeenCalled();
            work = 0;
            await minutes(4);
            expect(stop).not.toHaveBeenCalled();
            await minutes(1);
            expect(stop).toHaveBeenCalledTimes(1);
            dispose();
        });

        it("takes the whole window once a person has connected, and says when they were last here", async () => {
            const stop = jest.fn();
            let connected = 1;
            const at = Date.now() + 6 * 3_600_000;
            const prepareSleep = jest.fn(async () => true);
            const dispose = startIdleStop({ minutes: 20, logger }, probesOf({
                alarmBoot, connected: () => connected, nextPromisedWakeAt: async () => at, prepareSleep,
            }), stop);
            await minutes(1);
            const seenAt = Date.now();
            connected = 0;
            await minutes(19);
            expect(stop).not.toHaveBeenCalled();
            await minutes(1);
            expect(stop).toHaveBeenCalledTimes(1);
            expect(prepareSleep).toHaveBeenCalledWith(at, seenAt);
            dispose();
        });

        it("takes the whole window while a command a turn left running for the person is still up", async () => {
            const stop = jest.fn();
            let left = 1;
            const dispose = startIdleStop({ minutes: 20, logger }, probesOf({ alarmBoot, leftRunning: () => left }), stop);
            await minutes(19);
            expect(stop).not.toHaveBeenCalled();
            left = 0;
            await minutes(1);
            expect(stop).toHaveBeenCalledTimes(1);
            dispose();
        });
    });

    it("a failed clock read breaks the quiet streak, and recovery waits a new window", async () => {
        const stop = jest.fn();
        let failed = true;
        const dispose = startIdleStop({ minutes: 3, logger }, probesOf({ nextPromisedWakeAt: async () => {
            if (failed) { throw new Error("unreadable"); }
            return 0;
        } }), stop);
        await minutes(5);
        expect(stop).toHaveBeenCalledTimes(0);
        failed = false;
        await minutes(2);
        expect(stop).toHaveBeenCalledTimes(0);
        await minutes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    it("nothing on any clock reads as 0, not as a wake due at the epoch", async () => {
        const stop = jest.fn();
        const dispose = startIdleStop({ minutes: 5, logger }, probesOf({ nextPromisedWakeAt: () => Promise.resolve(0) }), stop);
        await minutes(5);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    // Simulates the terminal probe being an in-flight subprocess: unlike the other tests' already-settled promise, this
    // lets something become busy while the check awaits it.
    const held = () => {
        let resolve: ((at: number) => void) | undefined;
        return {
            probe: () =>
                new Promise<number>((r) => {
                    resolve = r;
                }),
            settle: async (at: number) => {
                resolve?.(at);
                // Let the suspended check resume and reach its verdict.
                await advanceTimersByTimeAsync(0);
            },
        };
    };

    it("a tab that connects while the terminal probe is in flight is not stopped under", async () => {
        const stop = jest.fn();
        let connected = 0;
        const tmux = held();
        const dispose = startIdleStop({ minutes: 5, logger }, probesOf({ connected: () => connected, terminalActivityAt: tmux.probe }), stop);
        // Five quiet minutes: the streak has outlasted the window, so this pass would otherwise stop the machine.
        await minutes(5);
        // ...and while it is still waiting on tmux, somebody opens the workspace.
        connected = 1;
        await tmux.settle(0);
        expect(stop).not.toHaveBeenCalled();
        dispose();
    });

    it("a watch armed while the terminal probe is in flight is not stopped under", async () => {
        const stop = jest.fn();
        let watchers = 0;
        const tmux = held();
        const dispose = startIdleStop({ minutes: 5, logger }, probesOf({ working: () => watchers, terminalActivityAt: tmux.probe }), stop);
        await minutes(5);
        // An agent arms a condition watch in the gap; this daemon is the only thing that can ever fire it.
        watchers = 1;
        await tmux.settle(0);
        expect(stop).not.toHaveBeenCalled();
        dispose();
    });

    it("a terminal probe that fails holds the machine up and says why, rather than reading as no activity", async () => {
        const stop = jest.fn();
        const warned: unknown[] = [];
        const failure = new Error("tmux: server busy");
        const watching = pino({ level: "warn" }, { write: (line: string) => void warned.push(JSON.parse(line).msg) });
        const dispose = startIdleStop({ minutes: 3, logger: watching }, probesOf({ terminalActivityAt: () => Promise.reject(failure) }), stop);
        await minutes(6);
        expect(stop).not.toHaveBeenCalled();
        expect(warned).toEqual(Array.from({ length: 6 }, () => "idle-stop check failed"));
        dispose();
    });

    it("terminal output advances the streak's start, one window after the last line, not two", async () => {
        const stop = jest.fn();
        let lastOutput = 0;
        const startedAt = Date.now();
        const dispose = startIdleStop({ minutes: 3, logger }, probesOf({ terminalActivityAt: () => Promise.resolve(lastOutput) }), stop);
        await minutes(2);
        // The stamp is on the fake timers' grid: advancing reads a millisecond ahead of the instant a check sees.
        lastOutput = startedAt + 2 * 60 * 1000;
        await minutes(2);
        expect(stop).not.toHaveBeenCalled();
        await minutes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });
});

describe("freshestPersonActivity", () => {
    test("a dev server's panel session is not a person: only the other sessions' stamps count", () => {
        const listing = ["panel-site--landing 9000", "agent-abc 120", "job-build 300", ""].join("\n");
        expect(freshestPersonActivity(listing)).toBe(300_000);
        expect(freshestPersonActivity("panel-site--landing 9000\n")).toBe(0);
        expect(freshestPersonActivity("")).toBe(0);
    });
});
