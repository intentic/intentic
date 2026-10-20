import { beginPulse, endPulse, turnPulseOf } from "../turn/turn-pulse.js";
import { weightedTokens } from "./burn-weight.js";
import { accountTokensBetween, meterTokens, meterTurnTotal, resetTokenMeter, turnRate, turnSpend } from "./token-meter.js";

const T0 = Date.parse("2026-10-20T15:45:00Z");
const MIN = 60_000;

const start = (conversationId: string, turnId: string, account: string, at = T0): void =>
    beginPulse({ conversationId, turnId, provider: "claude", harness: "native", model: "claude-opus-5-5", account, startedAt: at });

// The pulse a turn's runtime began, which the meter files its requests by.
const pulseOf = (conversationId: string): NonNullable<ReturnType<typeof turnPulseOf>> => {
    const pulse = turnPulseOf(conversationId);
    if (pulse === undefined) {
        throw new Error(`no turn running on ${conversationId}`);
    }
    return pulse;
};

afterEach(() => resetTokenMeter());

describe("the live token meter", () => {
    it("weighs the four kinds by their price ratios", () => {
        expect(weightedTokens({ input: 10, output: 10, cacheRead: 100, cacheWrite: 100 })).toBe(10 + 50 + 10 + 125);
    });

    it("files a turn's requests under the account its pulse names, by minute", () => {
        start("sub-a", "t1", "radarsu");
        start("sub-b", "t2", "artur");
        meterTokens(turnPulseOf("sub-a"), { output: 1_000 }, T0 + MIN);
        meterTokens(turnPulseOf("sub-a"), { output: 1_000 }, T0 + 2 * MIN);
        meterTokens(turnPulseOf("sub-b"), { output: 400 }, T0 + 2 * MIN);
        expect(accountTokensBetween("claude", "radarsu", T0, T0 + 3 * MIN)).toBe(10_000);
        expect(accountTokensBetween("claude", "radarsu", T0, T0 + 2 * MIN)).toBe(5_000);
        expect(accountTokensBetween("claude", "artur", T0, T0 + 3 * MIN)).toBe(2_000);
    });

    it("reads a running turn's rate over the last half hour of it", () => {
        start("sub-a", "t1", "radarsu");
        for (let minute = 1; minute <= 60; minute += 1) {
            meterTokens(turnPulseOf("sub-a"), { output: minute <= 30 ? 2_000 : 1_000 }, T0 + minute * MIN);
        }
        // The second half hour spent 30 × 5,000 weighted: 300,000 an hour.
        expect(turnRate("sub-a", T0 + 60 * MIN)).toEqual({ tokensPerHour: 300_000, observedMs: 30 * MIN });
    });

    it("ignores a turn's end-of-turn total once its requests were metered live, and takes it for one that was not", () => {
        start("sub-a", "t1", "radarsu");
        meterTokens(turnPulseOf("sub-a"), { output: 100 }, T0 + MIN);
        meterTurnTotal(pulseOf("sub-a"), { output: 100 }, T0 + 2 * MIN);
        expect(turnSpend("sub-a", "t1")?.weighted).toBe(500);
        start("codex-kid", "t9", "codex-subscription");
        meterTurnTotal(pulseOf("codex-kid"), { input: 1_000, output: 100 }, T0 + 10 * MIN);
        expect(turnSpend("codex-kid", "t9")).toEqual({ provider: "claude", model: "claude-opus-5-5", startedAt: T0, weighted: 1_500 });
    });

    it("opens a fresh meter for the conversation's next turn and meters nothing with no turn running", () => {
        start("sub-a", "t1", "radarsu");
        meterTokens(turnPulseOf("sub-a"), { output: 100 }, T0 + MIN);
        endPulse("sub-a", "t1", T0 + 2 * MIN);
        start("sub-a", "t2", "radarsu", T0 + 3 * MIN);
        meterTokens(turnPulseOf("sub-a"), { output: 10 }, T0 + 4 * MIN);
        expect(turnSpend("sub-a", "t1")).toBeUndefined();
        expect(turnSpend("sub-a", "t2")?.weighted).toBe(50);
        meterTokens(turnPulseOf("nobody"), { output: 10 }, T0 + 4 * MIN);
        expect(accountTokensBetween("claude", undefined, T0, T0 + 10 * MIN)).toBe(0);
    });
});
