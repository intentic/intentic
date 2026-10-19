// What SurfaceFlinger says reached the screen. `dumpsys SurfaceFlinger --latency <layer>` answers the refresh period
// and the last 128 frames a layer presented; polled every second it covers a whole scenario, and it works the same for
// every arm: a window drawn by the view system or a WebView, and the SurfaceView Flutter and the Rust renderer draw into.

/** One poll's answer: the refresh period and the present times, nanoseconds on the device's monotonic clock. */
export interface Latency {
    readonly refreshNs: number;
    readonly presents: readonly number[];
}

// A frame still waiting for its fence reads INT64_MAX; an empty slot reads 0.
const PENDING = 1e17;

export const parseLatency = (output: string): Latency => {
    const lines = output.trim().split(/\r?\n/u);
    const refreshNs = Number(lines[0]);
    const presents: number[] = [];
    for (const line of lines.slice(1)) {
        const fields = line.trim().split(/\s+/u).map(Number);
        const present = fields[1];
        if (fields.length === 3 && present !== undefined && present > 0 && present < PENDING) {
            presents.push(present);
        }
    }
    return { refreshNs: Number.isFinite(refreshNs) && refreshNs > 0 ? refreshNs : 16_666_667, presents };
};

/**
 * Polls between which frames may have gone unseen: the later poll's history is full and starts after everything the
 * earlier one saw, so presents in between fell out of SurfaceFlinger's 128 before anyone asked.
 */
export const lostBetweenPolls = (polls: readonly Latency[]): number => {
    let lost = 0;
    for (let index = 1; index < polls.length; index += 1) {
        const before = polls[index - 1]?.presents ?? [];
        const after = polls[index]?.presents ?? [];
        if (after.length >= 127 && before.length > 0 && (after[0] ?? 0) > (before.at(-1) ?? 0)) {
            lost += 1;
        }
    }
    return lost;
};

/** Present times from several polls, each once, in order. */
export const mergePresents = (polls: readonly Latency[]): number[] => [...new Set(polls.flatMap((poll) => poll.presents))].sort((a, b) => a - b);

export interface FrameStats {
    /** Frames presented while the content was moving. */
    readonly frames: number;
    /** Frames per second over the time the content was moving. */
    readonly fps: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
    readonly maxMs: number;
    /** Intervals longer than `lateAfter` refresh periods: a frame the screen showed late. */
    readonly janky: number;
    readonly jankPct: number;
    /** When the longest interval ended, ms after the first frame in the window: where to look for its cause. */
    readonly maxAtMs: number;
}

export interface Window {
    /** Present times before this (ns) are left out. */
    readonly fromNs?: number;
    readonly toNs?: number;
    /** A gap longer than this is the content standing still, not a slow frame. */
    readonly idleMs?: number;
    /**
     * How many refresh periods an interval may last before its frame counts as late: 1.5 while something moves every
     * frame (a fling). A streamed turn has stretches of up to 50ms with nothing new to draw (a tool call running),
     * which an arm that draws only on change rightly leaves blank. The turn steps on the frame clock, so such a
     * stretch ends three or four refreshes later depending on where the frame callback lands: the stream allows 4.5.
     */
    readonly lateAfter?: number;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** Frame intervals between consecutive presents inside the window, leaving out the gaps where nothing moved. */
export const frameStats = (presents: readonly number[], refreshNs: number, window: Window = {}): FrameStats => {
    const idleNs = (window.idleMs ?? 700) * 1e6;
    const inside = presents.filter((at) => at >= (window.fromNs ?? 0) && at <= (window.toNs ?? Number.MAX_VALUE));
    const intervals: number[] = [];
    let maxAtMs = 0;
    let longest = 0;
    for (let index = 1; index < inside.length; index += 1) {
        const gap = (inside[index] ?? 0) - (inside[index - 1] ?? 0);
        if (gap <= idleNs) {
            intervals.push(gap / 1e6);
            if (gap > longest) {
                longest = gap;
                maxAtMs = ((inside[index] ?? 0) - (inside[0] ?? 0)) / 1e6;
            }
        }
    }
    const sorted = intervals.toSorted((a, b) => a - b);
    const at = (share: number): number => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0);
    const movingMs = intervals.reduce((sum, interval) => sum + interval, 0);
    const janky = intervals.filter((interval) => interval > ((window.lateAfter ?? 1.5) * refreshNs) / 1e6).length;
    return {
        frames: intervals.length,
        fps: movingMs === 0 ? 0 : round((intervals.length / movingMs) * 1000),
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        p99Ms: at(0.99),
        maxMs: round(sorted.at(-1) ?? 0),
        janky,
        jankPct: intervals.length === 0 ? 0 : round((janky / intervals.length) * 100),
        maxAtMs: Math.round(maxAtMs),
    };
};

export const median = (values: readonly number[]): number => {
    const sorted = values.toSorted((a, b) => a - b);
    if (sorted.length === 0) {
        return Number.NaN;
    }
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};
