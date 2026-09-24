import { sumUsage } from "./turn-usage.js";

// A steered stream reports one usage frame per follow-up turn; the bill is their sum, the opening reading is the first.
test("sums what a turn spent, but keeps the first request's cache reading and fingerprint as they were", () => {
    const first = sumUsage(undefined, { kind: "usage", inputTokens: 10, cacheReadTokens: 100, openingCacheReadTokens: 100, openingCacheCreationTokens: 5, promptFingerprint: "a" });
    const both = sumUsage(first, { kind: "usage", inputTokens: 3, cacheReadTokens: 120, openingCacheReadTokens: 120, openingCacheCreationTokens: 9, promptFingerprint: "b" });
    expect(both).toEqual({
        kind: "usage",
        inputTokens: 13,
        cacheReadTokens: 220,
        openingCacheReadTokens: 100,
        openingCacheCreationTokens: 5,
        promptFingerprint: "a",
    });
});
