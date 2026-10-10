import { type SandboxMetrics, SandboxMetricsSchema } from "./metrics.js";

// A daemon payload from before memoryBreakdown and the other optional accounting fields existed.
const legacyMetrics = {
    at: 1_000_000,
    sandbox: {
        cores: 2,
        memoryBytes: 7 * 2 ** 30,
        memoryLimitBytes: 16 * 2 ** 30,
        loadAverage: [1.5, 1.25, 1],
        processes: 3,
    },
    daemon: { rssBytes: 300 * 2 ** 20, heapUsedBytes: 120 * 2 ** 20 },
    sessions: { "conv-a": { processes: 2, rssBytes: 400 * 2 ** 20 } },
    roles: {
        agentRuntime: { processes: 1, rssBytes: 300 * 2 ** 20 },
        terminal: { processes: 1, rssBytes: 100 * 2 ** 20 },
    },
} satisfies SandboxMetrics;

describe("the metrics memory accounting contract", () => {
    test("an older payload parses unchanged without the optional breakdown or its categories", () => {
        const parsed = SandboxMetricsSchema.parse(legacyMetrics);
        expect(parsed).toEqual(legacyMetrics);
        expect(Object.hasOwn(parsed.sandbox, "memoryBreakdown")).toBe(false);
    });

    test("a partial new breakdown preserves zero and leaves unmeasured categories absent", () => {
        const payload = {
            ...legacyMetrics,
            sandbox: {
                ...legacyMetrics.sandbox,
                memoryBreakdown: { anonymousBytes: 0, inactiveFileCacheBytes: 3 * 2 ** 30 },
            },
        };
        expect(SandboxMetricsSchema.parse(payload)).toEqual(payload);
    });

    test("each category is independently optional, with no zero defaults for the others", () => {
        for (const memoryBreakdown of [
            {},
            { anonymousBytes: 0 },
            { countedFileCacheBytes: 0 },
            { kernelBytes: 0 },
            { inactiveFileCacheBytes: 0 },
        ]) {
            const payload = { ...legacyMetrics, sandbox: { ...legacyMetrics.sandbox, memoryBreakdown } };
            expect(SandboxMetricsSchema.parse(payload)).toEqual(payload);
        }
    });

    test("measured resident categories remain separate from a headline that also counts full swap", () => {
        const payload = {
            ...legacyMetrics,
            sandbox: {
                ...legacyMetrics.sandbox,
                memoryBytes: 16.5 * 2 ** 30,
                swapBytes: 9.5 * 2 ** 30,
                swapLimitBytes: 10 * 2 ** 30,
                swapFull: true,
                memoryBreakdown: {
                    anonymousBytes: 5 * 2 ** 30,
                    countedFileCacheBytes: 2 ** 30,
                    kernelBytes: 2 ** 30,
                    inactiveFileCacheBytes: 3 * 2 ** 30,
                },
            },
        };
        expect(SandboxMetricsSchema.parse(payload)).toEqual(payload);
    });

    test("present categories must be byte numbers, not numeric strings or non-finite values", () => {
        for (const field of ["anonymousBytes", "countedFileCacheBytes", "kernelBytes", "inactiveFileCacheBytes"]) {
            for (const invalid of ["0", null, Number.NaN, Number.POSITIVE_INFINITY]) {
                const payload = { ...legacyMetrics, sandbox: { ...legacyMetrics.sandbox, memoryBreakdown: { [field]: invalid } } };
                expect(SandboxMetricsSchema.safeParse(payload).success).toBe(false);
            }
        }
    });
});
