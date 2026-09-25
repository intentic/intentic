import { toolCategoryOf } from "../../agent/tools/tool-calls.js";
import { planPhaseOf, toolCallOpened, usageTotals } from "./vendor-events.js";

const TOKENS = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 1 };

test("a turn that reported no usage has no usage frame, rather than one of zeros", () => {
    expect(usageTotals().frame()).toBeUndefined();
});

test("reports add up, and a cost appears only when the vendor priced a call", () => {
    const unpriced = usageTotals();
    unpriced.add(TOKENS);
    unpriced.add(TOKENS);
    expect(unpriced.frame()).toEqual({ kind: "usage", inputTokens: 200, outputTokens: 40, cacheReadTokens: 10, cacheCreationTokens: 2 });

    const priced = usageTotals();
    priced.add({ ...TOKENS, costUsd: 0 });
    priced.add({ ...TOKENS, costUsd: 0.25 });
    expect(priced.frame()).toEqual({ kind: "usage", inputTokens: 200, outputTokens: 40, cacheReadTokens: 10, cacheCreationTokens: 2, costUsd: 0.25 });
});

// OpenCode republishes a message's running totals as it streams: the last snapshot of each message is its whole spend.
test("a keyed report replaces that key's earlier snapshot instead of adding to it", () => {
    const totals = usageTotals();
    totals.add({ ...TOKENS, costUsd: 0.1 }, "message-1");
    totals.add({ ...TOKENS, inputTokens: 300, costUsd: 0.3 }, "message-1");
    totals.add({ ...TOKENS, costUsd: 0.1 }, "message-2");

    expect(totals.frame()).toEqual({ kind: "usage", inputTokens: 400, outputTokens: 40, cacheReadTokens: 10, cacheCreationTokens: 2, costUsd: 0.4 });
});

test("an opening tool call runs under the shared taxonomy's category, carrying only the details it has", () => {
    expect(toolCallOpened({ id: "c1", name: "Read", target: undefined, locations: undefined })).toEqual({
        kind: "tool_call",
        id: "c1",
        name: "Read",
        category: toolCategoryOf("Read"),
        status: "in_progress",
    });
    expect(
        toolCallOpened({
            id: "c2",
            name: "fetch_page",
            category: "fetch",
            status: "completed",
            target: "https://example.com",
            locations: [{ path: "notes.md" }],
            content: [{ type: "text", text: "ok" }],
        }),
    ).toEqual({
        kind: "tool_call",
        id: "c2",
        name: "fetch_page",
        category: "fetch",
        status: "completed",
        target: "https://example.com",
        locations: [{ path: "notes.md" }],
        content: [{ type: "text", text: "ok" }],
    });
});

test("a planning phase that never errored reads as not errored, and keeps what it held", () => {
    expect(planPhaseOf({})).toEqual({ sessionId: undefined, planText: undefined, errored: false });
    expect(planPhaseOf({ sessionId: "s1", planText: "1. do it", errored: true })).toEqual({ sessionId: "s1", planText: "1. do it", errored: true });
});
