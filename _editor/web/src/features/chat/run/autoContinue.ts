// Re-presses Continue after a turn stops short: a short, escalating ladder for ordinary stops (3 tries, then gives up),
// a long tail for a usage limit with no known reset. A try counts as progress by the turn's own duration, not by
// reading the transcript.

// Wait before each retry that bought nothing; undefined past the end means the automation gives up.
const TRANSIENT_DELAYS_MS = [5_000, 15_000, 45_000] as const;

// Long tail for a limit with no reset instant: same first three rungs, then widening to one probe a day forever.
const UNKNOWN_LIMIT_DELAYS_MS = [
    5_000,
    15_000,
    45_000,
    5 * 60_000,
    30 * 60_000,
    2 * 60 * 60_000,
    6 * 60 * 60_000,
    12 * 60 * 60_000,
    24 * 60 * 60_000,
] as const;

export type AutoContinueBlocker = "transient" | "limit";

export const autoContinueDelay = (triesWithoutProgress: number, blocker: AutoContinueBlocker = "transient"): number | undefined => {
    if (blocker === "limit") {
        return UNKNOWN_LIMIT_DELAYS_MS[Math.min(triesWithoutProgress, UNKNOWN_LIMIT_DELAYS_MS.length - 1)];
    }
    return TRANSIENT_DELAYS_MS[triesWithoutProgress];
};

// How many auto-continues before a hand press is needed; the number quoted in the final notice.
export const AUTO_CONTINUE_TRIES = TRANSIENT_DELAYS_MS.length;

// A turn at least this long counts as progress, resetting the retry ladder.
export const AUTO_CONTINUE_PROGRESS_MS = 30_000;
