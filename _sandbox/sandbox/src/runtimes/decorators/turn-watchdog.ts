// The two deadlines a vendor loop holds its turn to: silence for the inactivity window, or the turn outliving its hard
// cap. Only the clock and the wait live here; what a loop does once one passes (cancel, kill, refuse) stays its own, since
// each vendor stops differently.

import { within } from "@intentic/base/async";

export interface TurnTimeouts {
    readonly inactivityMs: number;
    readonly maxTurnMs: number;
}

// Two minutes of silence is a stuck turn; half an hour is the backstop even for one that keeps dribbling events.
export const DEFAULT_TURN_TIMEOUTS: TurnTimeouts = { inactivityMs: 120_000, maxTurnMs: 30 * 60_000 };

// What a pull answers once the loop should stop waiting: the source finished, or a deadline passed first.
export const SETTLED: unique symbol = Symbol("turn-settled");
export const EXPIRED: unique symbol = Symbol("turn-expired");

export interface TurnWatchdog {
    // Activity seen: the inactivity deadline moves a full window out from now.
    readonly touch: () => void;
    // A wait the vendor announced (a retry's next attempt, epoch ms): silence until then plus a window is not a hang.
    readonly extendPast: (instant: number) => void;
    // The turn is waiting on the daemon (an approval card open on a person), not on the vendor: neither deadline runs
    // until every hold is released. The last release counts as activity and moves the hard cap out by the time held, so
    // an answer that took an hour does not end the turn it answered. Returns the release, which counts once.
    readonly hold: () => () => void;
    // Milliseconds until the nearer deadline, or `until` (epoch ms) if that comes first; zero or less means one passed.
    // Infinite while the clock is held and no `until` is given.
    readonly remaining: (until?: number) => number;
    // Why the loop stopped waiting, read once it did: the sentence a timeout error is built around.
    readonly expiry: () => string;
}

// Whole minutes and seconds, the grain a person reads a turn's timing at.
const duration = (ms: number): string => {
    const seconds = Math.max(0, Math.round(ms / 1_000));
    return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
};

// Both deadlines start now: the hard cap moves only by time held, the inactivity one with every touch.
export const turnWatchdog = (timeouts: TurnTimeouts): TurnWatchdog => {
    const startedAt = Date.now();
    let turnDeadline = startedAt + timeouts.maxTurnMs;
    let inactivityDeadline = startedAt + timeouts.inactivityMs;
    let lastActivity = startedAt;
    // Holds open now, and when the first of them was taken.
    let holds = 0;
    let heldSince = startedAt;
    return {
        touch: () => {
            lastActivity = Date.now();
            inactivityDeadline = lastActivity + timeouts.inactivityMs;
        },
        extendPast: (instant) => {
            inactivityDeadline = Math.max(inactivityDeadline, instant + timeouts.inactivityMs);
        },
        hold: () => {
            if (holds === 0) {
                heldSince = Date.now();
            }
            holds += 1;
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                holds -= 1;
                if (holds > 0) {
                    return;
                }
                const now = Date.now();
                turnDeadline += now - heldSince;
                lastActivity = now;
                inactivityDeadline = Math.max(inactivityDeadline, now + timeouts.inactivityMs);
            };
        },
        remaining: (until = Number.POSITIVE_INFINITY) => (holds > 0 ? until : Math.min(inactivityDeadline, turnDeadline, until)) - Date.now(),
        expiry: () => {
            const now = Date.now();
            const silent = `the last event came ${duration(now - lastActivity)} ago`;
            if (now >= turnDeadline) {
                return `the turn reached its ${duration(timeouts.maxTurnMs)} cap (${silent})`;
            }
            if (now >= inactivityDeadline) {
                return `nothing arrived for ${duration(now - lastActivity)}, past the ${duration(timeouts.inactivityMs)} silence limit, ${duration(now - startedAt)} into the turn`;
            }
            return `the loop's own deadline passed ${duration(now - startedAt)} into the turn (${silent})`;
        },
    };
};

// How long a wait on a held clock sleeps before it looks again. A timer cannot be set for ever, and the release restarts
// the silence window a whole window out, so a look this often re-arms well before the next deadline.
const HELD_LOOK_MS = 1_000;

// The timer for a wait of `ms`: a held clock's endless wait becomes a look again.
const timerFor = (ms: number): number => (Number.isFinite(ms) ? Math.max(0, ms) : HELD_LOOK_MS);

// A loop's idle wait: parked until a producer wakes it or the time runs out, whichever is first. A wake with nothing
// parked is dropped, since the loop re-reads its queue before it parks again.
export interface IdleWait {
    readonly wake: () => void;
    readonly park: (ms: number) => Promise<void>;
}

export const idleWait = (): IdleWait => {
    const idle = (): void => {};
    let resolveWake: () => void = idle;
    return {
        wake: () => resolveWake(),
        park: async (ms) => {
            await within(
                new Promise<void>((resolve) => {
                    resolveWake = resolve;
                }),
                ms,
                undefined,
            );
            resolveWake = idle;
        },
    };
};

// The next item producers pushed, pulled under the turn's deadlines: each item taken is activity, SETTLED once the source
// says it is done with nothing left queued, EXPIRED when a deadline (or `until`, e.g. an abort's grace) passes first.
export const watchedPull =
    <T>(source: {
        readonly take: () => T | undefined;
        readonly settled: () => boolean;
        readonly clock: TurnWatchdog;
        readonly wait: IdleWait;
        readonly until?: () => number | undefined;
    }): (() => Promise<T | typeof SETTLED | typeof EXPIRED>) =>
    async () => {
        for (;;) {
            const item = source.take();
            if (item !== undefined) {
                source.clock.touch();
                return item;
            }
            if (source.settled()) {
                return SETTLED;
            }
            const ms = source.clock.remaining(source.until?.());
            if (ms <= 0) {
                return EXPIRED;
            }
            await source.wait.park(timerFor(ms));
        }
    };

// One pull from a vendor stream raced against the turn's nearer deadline; a pull that loses keeps running, so the caller
// owns catching it. The deadline is read again whenever the timer fires rather than trusted: a hold taken or released
// while the pull waits moves it.
export const beforeDeadline = async <T>(pending: Promise<T>, clock: TurnWatchdog): Promise<T | typeof EXPIRED> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof EXPIRED>((resolve) => {
        const look = (): void => {
            timer = setTimeout(() => (clock.remaining() <= 0 ? resolve(EXPIRED) : look()), timerFor(clock.remaining()));
        };
        look();
    });
    const result = await Promise.race([pending, expired]);
    clearTimeout(timer);
    return result;
};
