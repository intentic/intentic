import { quantile } from "../../../logs/diagnostics-shape.js";
import { addStored, BUCKETS, bucketOf, bucketValue, histogramQuantile, QUANTILE_ERROR, storedHistogram } from "./perf-histogram.js";

// The buckets every rollup row is written in: their edges, how close a percentile read off them comes, and that two of
// them add into what one histogram of both sets would have been.

const histogramOf = (durations: readonly number[]): Float64Array => {
    const counts = new Float64Array(BUCKETS);
    for (const ms of durations) {
        counts[bucketOf(ms)] = (counts[bucketOf(ms)] ?? 0) + 1;
    }
    return counts;
};

// A fixed spread of durations from 20 µs to two minutes, log-uniform with a heavy middle, the same on every run.
const durations = (seed: number, length: number): number[] => {
    let state = seed;
    const next = (): number => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 4_294_967_296;
    };
    return Array.from({ length }, () => 0.02 * 6_000_000 ** ((next() + next()) / 2));
};

test("bucket edges: under 10 µs is bucket 0, and each bucket above is a quarter octave from 10 µs up", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(0.009_99)).toBe(0);
    expect(bucketOf(-5)).toBe(0);
    expect(bucketOf(Number.NaN)).toBe(0);
    expect(bucketOf(0.01)).toBe(1);
    expect(bucketOf(0.02)).toBe(5);
    expect(bucketOf(1)).toBe(27);
    expect(bucketOf(1_000)).toBe(67);
    // Anything past the top edge, hours long, lands in the last bucket rather than past the end.
    expect(bucketOf(1e12)).toBe(BUCKETS - 1);
    expect(bucketValue(0)).toBe(0);
    expect(bucketValue(5)).toBeCloseTo(0.01 * 2 ** (4.5 / 4), 10);
});

test("a percentile read off the buckets is within the stated error of the exact one, at every rank asked", () => {
    const values = durations(7, 5_000);
    const counts = histogramOf(values);
    const ascending = values.toSorted((a, b) => a - b);
    const max = ascending.at(-1) ?? 0;
    expect(QUANTILE_ERROR).toBeCloseTo(0.0905, 3);
    for (const q of [0.01, 0.25, 0.5, 0.9, 0.95, 0.99, 0.999]) {
        const exact = quantile(ascending, q);
        const read = histogramQuantile(counts, values.length, q, ascending[0] ?? 0, max);
        expect(Math.abs(read - exact) / exact).toBeLessThanOrEqual(QUANTILE_ERROR);
    }
});

test("a percentile stays between the exact minimum and maximum, and an empty histogram reads zero", () => {
    const counts = histogramOf([100]);
    // 100 ms's bucket has its middle above 100 ms; the single span's own value is the most it can say.
    expect(bucketValue(bucketOf(100))).toBeGreaterThan(100);
    expect(histogramQuantile(counts, 1, 0.99, 0, 100)).toBe(100);
    // 20 ms's bucket has its middle below 20 ms; held at the minimum, a lone span reads exactly.
    expect(bucketValue(bucketOf(20))).toBeLessThan(20);
    expect(histogramQuantile(histogramOf([20]), 1, 0.5, 20, 20)).toBe(20);
    expect(histogramQuantile(new Float64Array(BUCKETS), 0, 0.5, 0, 0)).toBe(0);
});

test("two stored histograms add into the histogram of both sets, so a merged percentile is the union's", () => {
    const first = durations(1, 800);
    const second = durations(2, 300).map((ms) => ms * 3);
    const merged = new Float64Array(BUCKETS);
    expect(addStored(merged, storedHistogram(histogramOf(first)))).toBe(true);
    expect(addStored(merged, storedHistogram(histogramOf(second)))).toBe(true);

    const union = histogramOf([...first, ...second]);
    expect([...merged]).toEqual([...union]);
    const max = Math.max(...first, ...second);
    for (const q of [0.5, 0.9, 0.99]) {
        expect(histogramQuantile(merged, 1_100, q, 0, max)).toBe(histogramQuantile(union, 1_100, q, 0, max));
    }
});

test("a stored histogram keeps the counts from its first to its last occupied bucket, zeros between", () => {
    const counts = new Float64Array(BUCKETS);
    counts[30] = 2;
    counts[33] = 1;
    expect(storedHistogram(counts)).toEqual({ b0: 30, b: [2, 0, 0, 1] });
    expect(storedHistogram(new Float64Array(BUCKETS))).toEqual({ b0: 0, b: [] });
});

test("a stored histogram running past the last bucket is refused whole, adding nothing", () => {
    const into = new Float64Array(BUCKETS);
    expect(addStored(into, { b0: BUCKETS - 1, b: [1, 1] })).toBe(false);
    expect(into.every((count) => count === 0)).toBe(true);
});
