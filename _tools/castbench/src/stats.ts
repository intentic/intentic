// The arithmetic a run's numbers come from, apart from everything that measures them so it can be tested by value.

export interface Summary {
    readonly n: number;
    readonly p50: number | null;
    readonly p99: number | null;
    readonly mean: number | null;
    readonly max: number | null;
}

// One decimal: a millisecond's tenth is already below what one run repeats to.
export const round1 = (value: number): number => Math.round(value * 10) / 10;
// Two decimals for cores and Mbit/s, where 0.00 versus 0.01 is the claim being made.
const round2 = (value: number): number => Math.round(value * 100) / 100;

// Nearest rank: the smallest sample with at least `p` of the samples at or below it. Never interpolated, so a p99 is a
// latency some frame really had; undefined for no samples.
export const quantile = (sorted: readonly number[], p: number): number | undefined => {
    if (sorted.length === 0) {
        return undefined;
    }
    const rank = Math.ceil(p * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
};

export const summarize = (values: readonly number[]): Summary => {
    const sorted = [...values].sort((left, right) => left - right);
    const at = (p: number): number | null => {
        const value = quantile(sorted, p);
        return value === undefined ? null : round1(value);
    };
    return {
        n: sorted.length,
        p50: at(0.5),
        p99: at(0.99),
        mean: sorted.length === 0 ? null : round1(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
        max: sorted.length === 0 ? null : round1(sorted.at(-1)!),
    };
};

// How many events fell in each whole second of [from, to): the unit unique-fps is judged in, as voxl's clients count
// it. A partial last second is left out rather than read as a slow one.
export const perSecond = (times: readonly number[], from: number, to: number): number[] => {
    const seconds = Math.floor((to - from) / 1000);
    const counts = Array.from({ length: Math.max(0, seconds) }, () => 0);
    for (const time of times) {
        const bucket = Math.floor((time - from) / 1000);
        if (bucket >= 0 && bucket < counts.length) {
            counts[bucket]! += 1;
        }
    }
    return counts;
};

export interface RateSummary {
    readonly mean: number | null;
    readonly min: number | null;
    readonly p10: number | null;
}

export const summarizeRate = (counts: readonly number[]): RateSummary => {
    const sorted = [...counts].sort((left, right) => left - right);
    if (sorted.length === 0) {
        return { mean: null, min: null, p10: null };
    }
    return {
        mean: round1(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
        min: round1(sorted[0]!),
        p10: round1(quantile(sorted, 0.1)!),
    };
};

// A stall: the picture standing still for longer than this while the page kept drawing. Six frames of a 60 Hz page,
// long enough that no capture rate a pipeline picks explains it, short enough that a person sees the hitch.
export const STALL_MS = 100;

export interface Gaps {
    readonly stalls: number;
    readonly maxGapMs: number | null;
}

// The gaps between successive new pictures, `times` in the order they arrived, counted from `from` (the window's start,
// so a picture that never comes at all is a stall too) to `to`.
export const gapsOf = (times: readonly number[], from: number, to: number, stallMs = STALL_MS): Gaps => {
    const points = [from, ...times.filter((time) => time >= from && time <= to), to];
    let stalls = 0;
    let maxGap = 0;
    for (let index = 1; index < points.length; index++) {
        const gap = points[index]! - points[index - 1]!;
        maxGap = Math.max(maxGap, gap);
        if (gap > stallMs) {
            stalls += 1;
        }
    }
    return { stalls, maxGapMs: to > from ? round1(maxGap) : null };
};

// CPU cores a process used between two readings of its clock ticks (utime + stime from /proc), over `seconds` of wall
// time, at `ticksPerSecond` (USER_HZ, 100 on Linux).
export const coresOf = (ticksBefore: number, ticksAfter: number, seconds: number, ticksPerSecond = 100): number =>
    seconds > 0 ? round2((ticksAfter - ticksBefore) / ticksPerSecond / seconds) : 0;

// Mbit/s from bytes over milliseconds.
export const mbpsOf = (bytes: number, ms: number): number => (ms > 0 ? round2((bytes * 8) / (ms / 1000) / 1e6) : 0);
