import { SingleFlight } from "@intentic/base/async";

/* A PASS THAT RUNS WHEN SOMETHING CHANGES, NOT ON THE NEXT TICK. The resume pass and the automations pass each walked
   everything on an interval (5 s, 30 s), so whatever an event had just made due waited for the next beat: a context
   overflow "fired at once" fired up to five seconds later, a booked send kept its minute plus a beat (2026-10-20). Here
   a pass runs on three things: a nudge from an event that may have made something due, a timer armed for the soonest
   instant the last pass knew something falls due, and a slow backstop interval for anything an event missed. Every run
   is one pass at a time, as before: a call while a pass runs joins it. A nudge that arrives while a pass runs asks for
   one more pass after it, since that pass may have read the state before the event changed it. */

export interface NudgedPassOptions {
    // The backstop: a pass at least this often whatever was heard, for an event that can be missed.
    readonly backstopMs: number;
    // How long a nudge waits before its pass runs, so a burst of events (a turn settling sends several) is one pass.
    readonly settleMs?: number;
    // The least a due timer waits, so an instant that stays in the past (a hold the pass does not fire after all) costs
    // one pass a second at most, never a hot loop.
    readonly floorMs?: number;
    readonly failed: (error: Error) => void;
}

// What a pass reports as it runs: an instant (epoch ms) at which something it walked falls due.
export type DueAt = (at: number) => void;

export interface NudgedPass {
    // One pass; a call while a pass still runs joins that pass. `now` is the pass's clock, for tests.
    readonly run: (now?: number) => Promise<void>;
    // A pass soon, or once more right after the one running; repeated nudges before it runs are one pass.
    readonly nudge: () => void;
    readonly start: () => void;
    readonly stop: () => void;
}

const SETTLE_MS = 100;
const FLOOR_MS = 1_000;

export const nudgedPass = (pass: (now: number, due: DueAt) => Promise<void>, options: NudgedPassOptions): NudgedPass => {
    const settleMs = options.settleMs ?? SETTLE_MS;
    const floorMs = options.floorMs ?? FLOOR_MS;
    const passes = new SingleFlight<"pass", void>();
    let started = false;
    let backstop: NodeJS.Timeout | undefined;
    let soon: NodeJS.Timeout | undefined;
    let dueTimer: NodeJS.Timeout | undefined;
    // A nudge heard while a pass ran: that pass may have read the state before the event, so one more follows it.
    let again = false;

    const unrefd = (timer: NodeJS.Timeout): NodeJS.Timeout => {
        timer.unref();
        return timer;
    };
    // Only a started pass arms its own timers: a test driving `run` with its own clock gets none.
    const armDue = (instants: readonly number[]): void => {
        clearTimeout(dueTimer);
        dueTimer = undefined;
        if (!started || instants.length === 0) {
            return;
        }
        const at = Math.min(...instants);
        // A due past the backstop is the backstop's: setTimeout's ceiling is never reached, and nothing is lost.
        if (at - Date.now() >= options.backstopMs) {
            return;
        }
        // A timer may ring a moment early, and a pass run then would find its instant not yet come and leave it to the
        // backstop: it waits out the rest first. An instant already past waits the floor.
        const ring = (): void => {
            const left = at - Date.now();
            dueTimer = left > 0 ? unrefd(setTimeout(ring, left)) : undefined;
            if (dueTimer === undefined) {
                fire();
            }
        };
        dueTimer = unrefd(setTimeout(ring, at > Date.now() ? at - Date.now() : floorMs));
    };
    const run = (now: number = Date.now()): Promise<void> =>
        passes.run("pass", async () => {
            const instants: number[] = [];
            try {
                await pass(now, (at) => {
                    instants.push(at);
                });
            } finally {
                armDue(instants);
                // By the timer, not at once: this pass is still the one in flight until its promise settles.
                if (again && started) {
                    schedule();
                }
                again = false;
            }
        });
    const fire = (): void => {
        void run().catch(options.failed);
    };
    function schedule(): void {
        soon ??= unrefd(
            setTimeout(() => {
                soon = undefined;
                fire();
            }, settleMs),
        );
    }
    // Only a started pass hears nudges, as only it arms timers: one a test drives by `run` stays on the test's clock.
    const nudge = (): void => {
        if (!started) {
            return;
        }
        if (passes.joined("pass") === undefined) {
            schedule();
        } else {
            again = true;
        }
    };

    return {
        run,
        nudge,
        start: () => {
            if (started) {
                return;
            }
            started = true;
            // No pass at start: the first comes with the first event, due instant or backstop, as the interval's did.
            backstop = unrefd(setInterval(fire, options.backstopMs));
        },
        stop: () => {
            started = false;
            clearInterval(backstop);
            clearTimeout(soon);
            clearTimeout(dueTimer);
            soon = undefined;
            dueTimer = undefined;
        },
    };
};
