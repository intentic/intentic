import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { type QueryFn, streamSdk } from "./claude-code-stream.js";

const refused = "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.";
const repeated = new Error(`Claude Code returned an error result: ${refused}`);
// SAFETY: Partial SDK wire fixture supplying every assistant field read by streamSdk in these cases.
const assistant = {
    type: "assistant",
    session_id: "session",
    error: "authentication_failed",
    message: { content: [{ type: "text", text: refused }] },
} as SDKMessage;
const failure: AgentEvent = { kind: "error", code: "claude-token-refused", message: refused };
const opening: AgentEvent[] = [{ kind: "session", sessionId: "session" }, failure];

// A real Query can throw while reading or closing after it already reported the provider's refusal.
const query = (messages: readonly SDKMessage[], exit?: Error): QueryFn =>
    () => {
        const stream = (async function* () {
            yield* messages;
            if (exit !== undefined) {
                throw exit;
            }
        })();
        if (exit !== undefined) {
            stream.return = async () => {
                throw exit;
            };
        }
        return stream;
    };

const collect = async (queryFn: QueryFn, frames: AgentEvent[] = [], trial = false): Promise<AgentEvent[]> => {
    for await (const frame of streamSdk({
        queryFn,
        prompt: "finish the work",
        options: {},
        cwd: WORKSPACE_ROOT,
        tmuxEnabled: false,
        browserOutputDir: undefined,
        steering: undefined,
        redeliver: undefined,
        allowance: undefined,
        routed: undefined,
        trial,
        subagents: undefined,
        checklistSeed: undefined,
        carriedCostUsd: 0,
        posture: { mode: "default" },
    })) {
        frames.push(frame);
    }
    return frames;
};

const result = (subtype: "success" | "error_during_execution", message = refused): SDKMessage => {
    if (subtype === "success") {
        // SAFETY: Partial SDK success with a provider refusal; no accounting or context was reported.
        return { type: "result", subtype, is_error: true, result: message } as SDKMessage;
    }
    // SAFETY: Partial SDK error result; the fold reads errors and treats absent accounting as unreported.
    return { type: "result", subtype, is_error: true, errors: [message] } as SDKMessage;
};

// The SDK rewrites its exit error only after a result, so every repeat follows one.
test.each(["success", "error_during_execution"] as const)(
    "a refused credential keeps its classified failure when the SDK repeats it on exit after %s",
    async (subtype) => {
        expect(await collect(query([assistant, result(subtype)], repeated))).toEqual(opening);
    },
);

// A rate limit and a trial turn reword the provider's sentence in their frame; the SDK still repeats the sentence.
test.each([
    ["a rate limit", false, "rate_limit", "rate_limit"],
    ["a trial turn", true, "authentication_failed", "trial-model-unavailable"],
] as const)("%s keeps its reworded classified failure when the SDK repeats the provider's sentence", async (_case, trial, error, code) => {
    const said = "API Error: request refused upstream";
    // SAFETY: The shared refusal fixture with another category and sentence; still every assistant field the fold reads.
    const reworded = { ...assistant, error, message: { content: [{ type: "text", text: said }] } } as SDKMessage;
    const frames = await collect(query([reworded, result("error_during_execution", said)], new Error(`Claude Code returned an error result: ${said}`)), [], trial);
    expect(frames).toEqual([{ kind: "session", sessionId: "session" }, expect.objectContaining({ kind: "error", code })]);
    expect(frames[1]).not.toEqual(expect.objectContaining({ message: said }));
});

test("a result repeating the refusal keeps the same failure without needing an exit exception", async () => {
    expect(await collect(query([assistant, result("error_during_execution")]))).toEqual(opening);
});

test.each([new Error("process crashed"), new Error("Claude Code returned an error result: a different failure")])(
    "an unrelated SDK exit still surfaces: %s",
    async (exit) => {
        const frames: AgentEvent[] = [];
        await expect(collect(query([assistant], exit), frames)).rejects.toThrow(exit);
        expect(frames).toEqual(opening);
    },
);

test("an SDK error result with no reported refusal still surfaces", async () => {
    await expect(collect(query([], repeated))).rejects.toThrow(repeated);
});

test("a later successful result retires the earlier failure", async () => {
    // SAFETY: No accounting or context was reported; these are the only result fields the fold reads.
    const success = { type: "result", subtype: "success", is_error: false } as SDKMessage;
    const frames: AgentEvent[] = [];
    await expect(collect(query([assistant, success], repeated), frames)).rejects.toThrow(repeated);
    expect(frames).toEqual(opening);
});

test("a new main-thread response retires the earlier failure", async () => {
    // SAFETY: A message_start without usage resets the response without emitting any usage frames.
    const next = { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } } as SDKMessage;
    const frames: AgentEvent[] = [];
    await expect(collect(query([assistant, next], repeated), frames)).rejects.toThrow(repeated);
    expect(frames).toEqual(opening);
});

test("a child's response leaves the main-thread refusal standing", async () => {
    const child = { ...assistant, parent_tool_use_id: "child" };
    if (child.type === "assistant") {
        delete child.error;
    }
    expect(await collect(query([assistant, child], repeated))).toEqual(opening);
});

test("a child's refusal cannot suppress the main thread's exit", async () => {
    // SAFETY: Same refusal fixture, attributed to a child instead of this conversation's main thread.
    const child = { ...assistant, parent_tool_use_id: "child" } as SDKMessage;
    const frames: AgentEvent[] = [];
    await expect(collect(query([child], repeated), frames)).rejects.toThrow(repeated);
    expect(frames).toEqual([{ kind: "session", sessionId: "session" }]);
});

test("a result reporting a different failure still ends as a harness failure", async () => {
    const frames: AgentEvent[] = [];
    await expect(collect(query([assistant, result("error_during_execution", "different failure")], repeated), frames)).rejects.toThrow(repeated);
    expect(frames).toEqual([...opening, { kind: "error", code: "harness-incomplete", message: "agent did not complete (error_during_execution)" }]);
});

test("suppressing a repeated exit still accounts for the last requests", async () => {
    // SAFETY: Partial assistant with every field the failure and accounting folds read, including message id and usage.
    const metered = {
        type: "assistant",
        session_id: "session",
        error: "authentication_failed",
        message: { id: "message", content: [{ type: "text", text: refused }], usage: { input_tokens: 12, output_tokens: 3 } },
    } as SDKMessage;
    expect(await collect(query([metered], repeated))).toEqual([
        ...opening,
        { kind: "usage", inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
});
