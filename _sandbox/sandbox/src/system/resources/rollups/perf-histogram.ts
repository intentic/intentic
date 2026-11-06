// A fixed log-scale histogram of span durations. Every window, boot and release that keeps HISTOGRAM_VERSION uses the
// same bucket edges, so any two histograms add bucket by bucket and a percentile read off the sum is as good as one read
// off a single window: what lets ten-minute rollups answer for a day or a fortnight (perf-rollup.ts).

// Bumped whenever the edges below move; a reader skips a row of another version rather than misreading its buckets.
export const HISTOGRAM_VERSION = 1;

// Quarter-octave buckets: each spans a factor of 2^(1/4), about 1.19, so a value read at a bucket's geometric middle is
// within 2^(1/8) - 1, about 9.1%, of any value in it.
const PER_OCTAVE = 4;

// Bucket 0 holds every span under 10 µs (a zero-length one included); bucket i ≥ 1 holds [FLOOR·2^((i-1)/4), FLOOR·2^(i/4)).
const FLOOR_MS = 0.01;

// The top bucket starts near 2.2 hours and holds anything longer; the exact maximum is kept beside the counts.
export const BUCKETS = 120;

// The largest relative error of a percentile read from these buckets (see PER_OCTAVE).
export const QUANTILE_ERROR = 2 ** (1 / (2 * PER_OCTAVE)) - 1;

export const bucketOf = (ms: number): number => {
    // Negated, so NaN lands in bucket 0 with the zeros instead of indexing nowhere.
    if (!(ms >= FLOOR_MS)) {
        return 0;
    }
    return Math.min(BUCKETS - 1, 1 + Math.floor(Math.log2(ms / FLOOR_MS) * PER_OCTAVE));
};

/** The value a bucket stands for: its geometric middle; bucket 0 reads as 0. */
export const bucketValue = (index: number): number => (index <= 0 ? 0 : FLOOR_MS * 2 ** ((index - 0.5) / PER_OCTAVE));

/**
 * The value at fraction `q` of `total` spans counted in `counts` (nearest rank, as `quantile` in logs/diagnostics-shape.ts
 * reads a sorted list), held between the exact `minMs` and `maxMs`: a window of one span reads that span exactly.
 */
export const histogramQuantile = (counts: ArrayLike<number>, total: number, q: number, minMs: number, maxMs: number): number => {
    if (total <= 0) {
        return 0;
    }
    const rank = Math.min(total, Math.max(1, Math.ceil(q * total)));
    let seen = 0;
    for (let index = 0; index < counts.length; index += 1) {
        seen += counts[index] ?? 0;
        if (seen >= rank) {
            return Math.max(minMs, Math.min(bucketValue(index), maxMs));
        }
    }
    return maxMs;
};

// Two decimals below 10 ms, whole numbers above: both a sub-millisecond read and a multi-second scan stay readable.
export const roundMs = (ms: number): number => (ms < 10 ? Math.round(ms * 100) / 100 : Math.round(ms));

/** A histogram as a row stores it: the counts from the first occupied bucket (`b0`) to the last, zeros between kept. */
export interface StoredHistogram {
    readonly b0: number;
    readonly b: readonly number[];
}

export const storedHistogram = (counts: ArrayLike<number>): StoredHistogram => {
    let first = 0;
    while (first < counts.length && (counts[first] ?? 0) === 0) {
        first += 1;
    }
    let last = counts.length - 1;
    while (last > first && (counts[last] ?? 0) === 0) {
        last -= 1;
    }
    return { b0: first < counts.length ? first : 0, b: Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => counts[first + offset] ?? 0) };
};

/** Adds a stored histogram into `into`; false, adding nothing, when it runs past the buckets these edges have. */
export const addStored = (into: Float64Array, stored: StoredHistogram): boolean => {
    if (stored.b0 + stored.b.length > into.length) {
        return false;
    }
    stored.b.forEach((count, offset) => {
        into[stored.b0 + offset] = (into[stored.b0 + offset] ?? 0) + count;
    });
    return true;
};
