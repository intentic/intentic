import { beginPulse, endPulse } from "../turn/turn-pulse.js";
import { MessageTally } from "./message-tally.js";
import { resetTokenMeter, turnSpend } from "./token-meter.js";

const frames = <T>(generator: Generator<T>): T[] => [...generator];

afterEach(() => resetTokenMeter());

describe("a stream's messages, counted for what they spent", () => {
    it("counts a message read twice once, adding only what grew between the readings, onto the conversation's meter", () => {
        beginPulse({ conversationId: "sub-a", turnId: "t1", provider: "claude", harness: "native", account: "radarsu", startedAt: 0 });
        const tally = new MessageTally("sub-a");
        expect(tally.take("m1", { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 500 })).toEqual({ input: 2, output: 10, cacheRead: 500, cacheWrite: 0 });
        expect(tally.take("m1", { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 500 })).toBeUndefined();
        expect(tally.take("m1", { input_tokens: 2, output_tokens: 25, cache_read_input_tokens: 500 })).toEqual({ input: 0, output: 15, cacheRead: 0, cacheWrite: 0 });
        expect(turnSpend("sub-a", "t1")?.weighted).toBe(2 + 25 * 5 + 50);
        expect(frames(tally.owedFrames())).toEqual([{ kind: "usage", inputTokens: 2, outputTokens: 25, cacheReadTokens: 500, cacheCreationTokens: 0 }]);
        endPulse("sub-a", "t1");
    });

    it("owes nothing a result accounted for, says what it owes once, and frames a result's own spend off the running total", () => {
        const tally = new MessageTally(undefined, 1.5);
        tally.take("m1", { output_tokens: 10 });
        expect(frames(tally.resultFrames({ usage: { output_tokens: 10 }, total_cost_usd: 2, num_turns: 1 }, { fingerprint: "abc" }))).toEqual([
            { kind: "usage", costUsd: 0.5, outputTokens: 10, numTurns: 1, promptFingerprint: "abc" },
        ]);
        tally.take("m2", { output_tokens: 4, cache_creation_input_tokens: null });
        expect(frames(tally.owedFrames())).toEqual([{ kind: "usage", inputTokens: 0, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 }]);
        expect(frames(tally.owedFrames())).toEqual([]);
        // A result with no accounting at all says nothing.
        expect(frames(tally.resultFrames({ duration_ms: 5 }))).toEqual([]);
    });

    it("counts a message with no id as it comes, and nothing for one with no usage", () => {
        const tally = new MessageTally(undefined);
        expect(tally.take(undefined, { input_tokens: 7 })).toEqual({ input: 7, output: 0, cacheRead: 0, cacheWrite: 0 });
        expect(tally.take("m1", undefined)).toBeUndefined();
    });
});
