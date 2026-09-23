// The two deadlines a vendor loop holds its turn to: silence for the inactivity window, or the turn outliving its hard
// cap. Only the clock and the wait live here; what a loop does once one passes (cancel, kill, refuse) stays its own, since
// each vendor stops differently.

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
    // Milliseconds until the nearer deadline, or `until` (epoch ms) if that comes first; zero or less means one passed.
    readonly remaining: (until?: number) => number;
}

// Both deadlines start now: the hard cap is fixed, the inactivity one moves with every touch.
export const turnWatchdog = (timeouts: TurnTimeouts): TurnWatchdog => {
    const turnDeadline = Date.now() + timeouts.maxTurnMs;
    let inactivityDeadline = Date.now() + timeouts.inactivityMs;
    return {
        touch: () => {
            inactivityDeadline = Date.now() + timeouts.inactivityMs;
        },
        extendPast: (instant) => {
            inactivityDeadline = Math.max(inactivityDeadline, instant + timeouts.inactivityMs);
        },
        remaining: (until = Number.POSITIVE_INFINITY) => Math.min(inactivityDeadline, turnDeadline, until) - Date.now(),
    };
};

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
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                new Promise<void>((resolve) => {
                    resolveWake = resolve;
                }),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, ms);
                }),
            ]);
            clearTimeout(timer);
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
            await source.wait.park(ms);
        }
    };

// One pull from a vendor stream raced against the turn's nearer deadline; a pull that loses keeps running, so the caller
// owns catching it.
export const beforeDeadline = async <T>(pending: Promise<T>, clock: TurnWatchdog): Promise<T | typeof EXPIRED> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof EXPIRED>((resolve) => {
        timer = setTimeout(() => resolve(EXPIRED), Math.max(0, clock.remaining()));
    });
    const result = await Promise.race([pending, expired]);
    clearTimeout(timer);
    return result;
};
