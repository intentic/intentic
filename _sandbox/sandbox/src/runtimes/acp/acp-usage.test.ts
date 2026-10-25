import type { PromptResponse } from "@agentclientprotocol/sdk/unstable";
import { unstubbed } from "@intentic/testing";
import type { AcpConnection } from "./acp-connection.js";
import { promptUsage } from "./acp-usage.js";

// What an ACP turn cost, from the usage its prompt response carries: a session's running totals read as each turn's
// difference, a smaller reading as a turn's own count, and no usage as no reading at all.

const reply = (inputTokens: number, outputTokens: number, cachedReadTokens = 0): PromptResponse => ({
    stopReason: "end_turn",
    usage: { totalTokens: inputTokens + outputTokens, inputTokens, outputTokens, cachedReadTokens },
});

test("a session's running totals are read as what each turn added", () => {
    const process = unstubbed<AcpConnection>("connection", {});
    expect(promptUsage(process, "s-1", reply(1_000, 100, 800))).toEqual({ kind: "usage", inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 0 });
    expect(promptUsage(process, "s-1", reply(2_500, 180, 2_000))).toEqual({ kind: "usage", inputTokens: 1_500, outputTokens: 80, cacheReadTokens: 1_200, cacheCreationTokens: 0 });
    // Another session of the same process keeps its own totals.
    expect(promptUsage(process, "s-2", reply(300, 30))).toMatchObject({ inputTokens: 300, outputTokens: 30, cacheReadTokens: 0 });
});

test("a reading smaller than the last is a turn's own count, and a response with no usage reports none", () => {
    const process = unstubbed<AcpConnection>("connection", {});
    promptUsage(process, "s-1", reply(5_000, 500));
    expect(promptUsage(process, "s-1", reply(900, 90))).toMatchObject({ inputTokens: 900, outputTokens: 90 });
    expect(promptUsage(process, "s-1", { stopReason: "end_turn" })).toBeUndefined();
    expect(promptUsage(process, "s-1", undefined)).toBeUndefined();
});
