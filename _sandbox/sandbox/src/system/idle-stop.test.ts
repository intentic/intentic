import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIdleStop, type IdleStopProbes } from "./idle-stop.js";

const logger = pino({ level: "silent" });

const probesOf = (over: Partial<IdleStopProbes>): IdleStopProbes => ({
    connected: () => 0,
    turns: () => 0,
    delegates: () => 0,
    watchers: () => 0,
    terminalActivityAt: () => Promise.resolve(0),
    ...over,
});

// The interval is a minute; advancing N minutes runs N checks (each awaited via the async timer API).
const minutes = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
        await vi.advanceTimersByTimeAsync(60 * 1000);
    }
};

describe("startIdleStop", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("stops after the quiet window when nothing is connected or running", async () => {
        const stop = vi.fn();
        const dispose = startIdleStop({ minutes: 5, logger }, probesOf({}), stop);
        await minutes(4);
        expect(stop).not.toHaveBeenCalled();
        await minutes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    it("a connected tab resets the streak: even an idle one counts as a person", async () => {
        const stop = vi.fn();
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
        const stop = vi.fn();
        let turns = 1;
        const dispose = startIdleStop({ minutes: 2, logger }, probesOf({ turns: () => turns }), stop);
        await minutes(6);
        expect(stop).not.toHaveBeenCalled();
        turns = 0;
        await minutes(2);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    it("an armed condition watch keeps the machine up: stopping it is how a watch never fires", async () => {
        const stop = vi.fn();
        let watchers = 1;
        const dispose = startIdleStop({ minutes: 2, logger }, probesOf({ watchers: () => watchers }), stop);
        await minutes(6);
        expect(stop).not.toHaveBeenCalled();
        watchers = 0;
        await minutes(2);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });

    /* THE PROBE IS A SUBPROCESS, AND THE WORLD MOVES WHILE IT RUNS. Every test above resolves
     * terminalActivityAt on an already-settled promise, so the check never actually suspends and the
     * live probes it read a line earlier cannot go stale. Production's probe spawns `tmux list-panes`,
     * which is milliseconds at best and seconds on the loaded box this feature exists for, and the
     * verdict is reached on the far side of that await. Anything that becomes busy in between is
     * invisible to the pass that is about to SIGTERM the daemon. */
    const held = (): { probe: () => Promise<number>; settle: (at: number) => Promise<void> } => {
        let resolve: ((at: number) => void) | undefined;
        return {
            probe: () =>
                new Promise<number>((r) => {
                    resolve = r;
                }),
            settle: async (at) => {
                resolve?.(at);
                // Let the suspended check resume and reach its verdict.
                await vi.advanceTimersByTimeAsync(0);
            },
        };
    };

    it("a tab that connects while the terminal probe is in flight is not stopped under", async () => {
        const stop = vi.fn();
        let connected = 0;
        const tmux = held();
        const dispose = startIdleStop({ minutes: 5, logger }, probesOf({ connected: () => connected, terminalActivityAt: tmux.probe }), stop);
        // Five quiet minutes: the streak has outlasted the window, so this pass would stop the machine.
        await minutes(5);
        // ...and while it is still waiting on tmux, somebody opens the workspace.
        connected = 1;
        await tmux.settle(0);
        expect(stop).not.toHaveBeenCalled();
        dispose();
    });

    it("a watch armed while the terminal probe is in flight is not stopped under", async () => {
        const stop = vi.fn();
        let watchers = 0;
        const tmux = held();
        const dispose = startIdleStop({ minutes: 5, logger }, probesOf({ watchers: () => watchers, terminalActivityAt: tmux.probe }), stop);
        await minutes(5);
        // An agent arms a condition watch in the gap; this daemon is the only thing that can ever fire it.
        watchers = 1;
        await tmux.settle(0);
        expect(stop).not.toHaveBeenCalled();
        dispose();
    });

    it("terminal output advances the streak's start, one window after the last line, not two", async () => {
        const stop = vi.fn();
        let lastOutput = 0;
        const dispose = startIdleStop({ minutes: 3, logger }, probesOf({ terminalActivityAt: () => Promise.resolve(lastOutput) }), stop);
        await minutes(2);
        lastOutput = Date.now();
        await minutes(2);
        expect(stop).not.toHaveBeenCalled();
        await minutes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });
});
