/* HOW A RATE IS LEARNED FROM WHAT THE METER SAW AND WHAT THE READINGS SAID, with no I/O.

   Two figures, each a running average so one odd interval moves it only part of the way:
   - what one point of an account's window costs, in the meter's unit (burn-weight.ts): the tokens metered on the
     account between two readings over the points its window moved. Readings come in whole percents, so an interval is
     taken only once the window moved MIN_POINTS or more, its first reading the anchor until then. A reset (the window
     reopened, or fell back) re-anchors. Use from outside this sandbox (the owner's own Claude Code, another sandbox on
     the account) moves the window without moving the meter, and so reads as a cheaper point: the account's figure
     then says how fast the window really moves per token this sandbox spends, which is what a projection needs.
   - what a model spends an hour, and for how long a child's turn on it runs: from each turn that ran long enough to be
     a pace rather than a burst. */

// Points a window must move before the interval is read: whole-percent readings make one point a 100% error.
export const MIN_POINTS = 4;
// How much of the way one new sample moves the average.
const EWMA_ALPHA = 0.3;
// Once an average has this many samples, one sample beyond this factor of it is clamped: a window moved by somebody else
// while this sandbox was idle would otherwise read as a point costing nearly nothing.
const SETTLED_SAMPLES = 3;
const OUTLIER_FACTOR = 3;
// Two resets this close are the same window's.
const SAME_RESET_S = 10 * 60;

export interface Average {
    readonly value: number;
    readonly samples: number;
    readonly at: number;
}

/** The average with one more sample in it. */
export const averaged = (before: Average | undefined, sample: number, at: number): Average => {
    if (before === undefined || before.samples === 0) {
        return { value: sample, samples: 1, at };
    }
    const kept = before.samples >= SETTLED_SAMPLES ? Math.min(before.value * OUTLIER_FACTOR, Math.max(before.value / OUTLIER_FACTOR, sample)) : sample;
    return { value: before.value * (1 - EWMA_ALPHA) + kept * EWMA_ALPHA, samples: before.samples + 1, at };
};

/** Where a window stood when an interval opened. */
export interface Anchor {
    readonly utilization: number;
    readonly resetsAt?: number | undefined;
    readonly at: number;
}

/** One window as one reading has it. */
export interface WindowPoint {
    readonly utilization: number;
    readonly resetsAt?: number | undefined;
    readonly at: number;
}

const sameWindow = (anchor: Anchor, point: WindowPoint): boolean =>
    anchor.resetsAt === undefined || point.resetsAt === undefined || Math.abs(anchor.resetsAt - point.resetsAt) <= SAME_RESET_S;

/** One reading's step: the anchor the next interval opens from, and the interval's tokens per point where it closed one. */
export interface AnchorStep {
    readonly anchor: Anchor;
    readonly tokensPerPoint?: number;
}

/**
 * Moves a window's anchor on by one reading: the interval's tokens per point once it moved far enough, and the anchor the
 * next interval opens from. `metered` answers what was spent on the account in [from, to), or undefined where the meter
 * does not reach that far back.
 */
export const stepAnchor = (
    anchor: Anchor | undefined,
    point: WindowPoint,
    metered: (from: number, to: number) => number | undefined,
): AnchorStep => {
    const fresh: Anchor = { utilization: point.utilization, resetsAt: point.resetsAt, at: point.at };
    if (anchor === undefined || point.at <= anchor.at || !sameWindow(anchor, point) || point.utilization < anchor.utilization) {
        return { anchor: fresh };
    }
    const moved = point.utilization - anchor.utilization;
    if (moved < MIN_POINTS) {
        return { anchor };
    }
    const spent = metered(anchor.at, point.at);
    // Nothing metered while the window moved: somebody else spent it, and there is no ratio to learn from that.
    return spent === undefined || spent <= 0 ? { anchor: fresh } : { anchor: fresh, tokensPerPoint: spent / moved };
};

// A turn shorter than this is a burst (its opening cache write, one answer), not the pace a model keeps.
export const MIN_PACE_MS = 10 * 60_000;
