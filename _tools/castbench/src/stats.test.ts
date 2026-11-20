import { coresOf, gapsOf, mbpsOf, perSecond, quantile, STALL_MS, summarize, summarizeRate } from "./stats.js";

// The arithmetic every reported number passes through, by value at its edges.

describe("quantile", () => {
    it("is the nearest rank: a value some sample really had, never an interpolation", () => {
        const sorted = [10, 20, 30, 40];
        expect(quantile(sorted, 0.5)).toBe(20);
        expect(quantile(sorted, 0.51)).toBe(30);
        expect(quantile(sorted, 0.99)).toBe(40);
        expect(quantile(sorted, 0)).toBe(10);
    });

    it("of a hundred samples, p99 is the 99th and not the largest", () => {
        const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
        expect(quantile(sorted, 0.99)).toBe(99);
        expect(quantile(sorted, 0.5)).toBe(50);
    });

    it("is undefined with no samples", () => {
        expect(quantile([], 0.5)).toBeUndefined();
    });
});

describe("summarize", () => {
    it("sorts, counts and rounds to a tenth", () => {
        expect(summarize([30.04, 10, 20.06])).toEqual({ n: 3, p50: 20.1, p99: 30, mean: 20, max: 30 });
    });

    it("reports nulls, not zeros, for no samples", () => {
        expect(summarize([])).toEqual({ n: 0, p50: null, p99: null, mean: null, max: null });
    });
});

describe("perSecond", () => {
    it("buckets events into whole seconds from the window's start and drops a partial last second", () => {
        expect(perSecond([0, 999, 1000, 1500, 2999, 3100], 0, 3500)).toEqual([2, 2, 1]);
    });

    it("ignores events outside the window", () => {
        expect(perSecond([-1, 5000], 0, 2000)).toEqual([0, 0]);
    });
});

describe("summarizeRate", () => {
    it("gives the mean, the worst second and the tenth percentile second", () => {
        expect(summarizeRate([60, 58, 30, 60, 60, 60, 60, 60, 60, 60])).toEqual({ mean: 56.8, min: 30, p10: 30 });
    });

    it("is all nulls for a window too short to hold a whole second", () => {
        expect(summarizeRate([])).toEqual({ mean: null, min: null, p10: null });
    });
});

describe("gapsOf", () => {
    it("counts a gap only when it is longer than the stall threshold", () => {
        expect(STALL_MS).toBe(100);
        expect(gapsOf([100, 200, 301], 0, 400)).toEqual({ stalls: 1, maxGapMs: 101 });
    });

    it("counts the wait for the first picture and after the last one", () => {
        expect(gapsOf([150, 200], 0, 350)).toEqual({ stalls: 2, maxGapMs: 150 });
    });

    it("reads a window with no picture at all as one stall the window long", () => {
        expect(gapsOf([], 1000, 3000)).toEqual({ stalls: 1, maxGapMs: 2000 });
    });
});

describe("coresOf and mbpsOf", () => {
    it("turns clock ticks over wall time into cores, to two decimals", () => {
        expect(coresOf(1000, 1252, 12)).toBe(0.21);
        expect(coresOf(500, 500, 12)).toBe(0);
    });

    it("turns bytes over milliseconds into Mbit/s", () => {
        expect(mbpsOf(1_500_000, 12_000)).toBe(1);
        expect(mbpsOf(10, 0)).toBe(0);
    });
});
