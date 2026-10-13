import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { museFailureFrame, museFrames, museStreamState, type MuseStreamState, museUsageFrame } from "./muse-stream.js";
import { type MuseNotification, readMuseEvent } from "./muse-wire.js";

const CWD = WORKSPACE_ROOT;

// Each notification as the host would send it, read through the same boundary the loop reads it through.
const framesOf = (notifications: readonly MuseNotification[], state: MuseStreamState = museStreamState(), now = (): number => 1_000): AgentEvent[] =>
    notifications.flatMap((notification) => {
        const event = readMuseEvent(notification);
        return event === undefined ? [] : [...museFrames(event, { cwd: CWD, now }, state)];
    });

const item = (method: string, fields: Record<string, unknown>): MuseNotification => ({
    method,
    params: { sessionId: "s1", viewCursor: "v:1", item: { revision: 1, turnId: "t1", ...fields } },
});

test("prose streams as deltas and its completion adds only what the deltas missed, then ends the bubble", () => {
    expect(
        framesOf([
            item("item/started", { itemId: "m1", kind: "agentMessage", status: "inProgress", text: "" }),
            { method: "item/delta", params: { sessionId: "s1", viewCursor: "v", itemId: "m1", field: "text", delta: "Hello" } },
            item("item/completed", { itemId: "m1", kind: "agentMessage", status: "completed", text: "Hello there" }),
        ]),
    ).toEqual([{ kind: "delta", text: "Hello" }, { kind: "delta", text: " there" }, { kind: "text_end" }]);
});

test("a reasoning summary streams as thinking, a new part starting a new paragraph", () => {
    expect(
        framesOf([
            { method: "item/delta", params: { sessionId: "s1", viewCursor: "v", itemId: "r1", field: "summary.0", delta: "Reading" } },
            { method: "item/delta", params: { sessionId: "s1", viewCursor: "v", itemId: "r1", field: "summary.0", delta: " files" } },
            { method: "item/delta", params: { sessionId: "s1", viewCursor: "v", itemId: "r1", field: "summary.1", delta: "Editing" } },
        ]),
    ).toEqual([
        { kind: "thinking", text: "Reading" },
        { kind: "thinking", text: " files" },
        { kind: "thinking", text: "\nEditing" },
    ]);
});

test("a shell call opens as Bash, streams its output, and settles with the command's own output and exit code", () => {
    const args = JSON.stringify({ command: "pnpm test", description: "Run tests" });
    const envelope = JSON.stringify({ command: "pnpm test", exit_code: 1, output: "1 failed\n", terminal_status: "completed" });
    expect(
        framesOf([
            item("item/started", { itemId: "c1", kind: "toolCall", status: "inProgress", tool: "bash", args }),
            { method: "item/delta", params: { sessionId: "s1", viewCursor: "v", itemId: "c1", field: "output", delta: "1 failed\n" } },
            item("item/completed", { itemId: "c1", kind: "toolCall", status: "completed", tool: "bash", args, visibleOutput: envelope }),
        ]),
    ).toEqual([
        { kind: "tool_call", id: "c1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
        { kind: "tool_call_update", id: "c1", content: [{ type: "text", text: "1 failed\n" }] },
        { kind: "tool_call_update", id: "c1", status: "failed", content: [{ type: "text", text: "1 failed\n" }], exitCode: 1 },
    ]);
});

test("an edit carries its file as a workspace location and its change as a diff, which the verification ledger reads", () => {
    const edit = JSON.stringify({ path: `${WORKSPACE_ROOT}/src/app.ts`, find: "a()", replace: "b()" });
    const write = JSON.stringify({ path: "notes.md", content: "# Notes\n" });
    expect(
        framesOf([
            item("item/started", { itemId: "e1", kind: "toolCall", status: "inProgress", tool: "edit_file", args: edit }),
            item("item/completed", { itemId: "e1", kind: "toolCall", status: "completed", tool: "edit_file", args: edit, patchSummary: { added: 1, removed: 1, files: 1 } }),
            item("item/started", { itemId: "w1", kind: "toolCall", status: "inProgress", tool: "write_file", args: write }),
            item("item/completed", { itemId: "w1", kind: "toolCall", status: "completed", tool: "write_file", args: write }),
        ]),
    ).toEqual([
        {
            kind: "tool_call",
            id: "e1",
            name: "Edit",
            category: "edit",
            status: "in_progress",
            target: "src/app.ts",
            locations: [{ path: "src/app.ts" }],
            content: [{ type: "diff", path: "src/app.ts", oldText: "a()", newText: "b()" }],
        },
        { kind: "tool_call_update", id: "e1", status: "completed" },
        {
            kind: "tool_call",
            id: "w1",
            name: "Write",
            category: "edit",
            status: "in_progress",
            target: "notes.md",
            locations: [{ path: "notes.md" }],
            content: [{ type: "diff", path: "notes.md", newText: "# Notes\n" }],
        },
        { kind: "tool_call_update", id: "w1", status: "completed" },
    ]);
});

test("a call refused at its approval settles failed with Muse's reason, and a read names its file", () => {
    const read = JSON.stringify({ path: "README.md" });
    expect(
        framesOf([
            item("item/completed", { itemId: "x1", kind: "toolCall", status: "rejected", tool: "bash", args: JSON.stringify({ command: "rm -rf /" }), failureReason: "approval aborted" }),
            item("item/started", { itemId: "r1", kind: "toolCall", status: "inProgress", tool: "read_file", args: read }),
            item("item/completed", { itemId: "r1", kind: "toolCall", status: "completed", tool: "read_file", args: read, visibleOutput: "1|hi" }),
        ]),
    ).toEqual([
        { kind: "tool_call", id: "x1", name: "Bash", category: "execute", status: "failed", target: "rm -rf /", content: [{ type: "text", text: "approval aborted" }] },
        { kind: "tool_call", id: "r1", name: "Read", category: "read", status: "in_progress", target: "README.md", locations: [{ path: "README.md" }] },
        { kind: "tool_call_update", id: "r1", status: "completed", content: [{ type: "text", text: "1|hi" }] },
    ]);
});

test("a plan update is the checklist; a background reminder observer and the turn's own prompt show nothing", () => {
    const plan = JSON.stringify({ plan: [{ step: "read", status: "completed" }, { step: "edit", status: "in_progress" }] });
    expect(
        framesOf([
            item("item/started", { itemId: "p1", kind: "toolCall", status: "inProgress", tool: "update_plan", args: plan }),
            item("item/completed", { itemId: "p1", kind: "toolCall", status: "completed", tool: "update_plan", args: plan }),
            item("item/started", { itemId: "rc", kind: "reminderChild", status: "inProgress" }),
            item("item/completed", { itemId: "u1", kind: "userMessage", status: "completed", text: "do it" }),
        ]),
    ).toEqual([
        {
            kind: "todos",
            items: [
                { content: "read", status: "completed" },
                { content: "edit", status: "in_progress" },
            ],
        },
    ]);
});

test("context fill needs its window; a retry is a provider_retry with Muse's own counters; a model change re-inits", () => {
    const state = museStreamState();
    expect(
        framesOf(
            [
                { method: "session/contextUsage", params: { sessionId: "s1", viewCursor: "v", usedTokens: 5_000, pressure: "normal" } },
                { method: "session/contextUsage", params: { sessionId: "s1", viewCursor: "v", usedTokens: 5_000, windowTokens: 200_000, pressure: "normal" } },
                {
                    method: "turn/retryScheduled",
                    params: { sessionId: "s1", viewCursor: "v", turnId: "t1", attempt: 1, nextAttempt: 2, maxAttempts: 10, retryDelayMs: 4_000, httpStatus: 529, reason: "overloaded" },
                },
                { method: "session/modelChanged", params: { sessionId: "s1", viewCursor: "v", modelId: "muse-spark-1.2", providerId: "meta", source: "x" } },
            ],
            state,
        ),
    ).toEqual([
        { kind: "context_usage", tokens: 5_000, contextWindow: 200_000 },
        { kind: "provider_retry", attempt: 2, maxAttempts: 10, nextAttemptAt: 5_000, status: 529 },
        { kind: "init", model: "muse-spark-1.2" },
    ]);
    expect(state.retried).toBe(true);
});

test("usage sums the turn's model calls, cache reads and writes apart from fresh input, and none is said without a call", () => {
    const state = museStreamState();
    state.turnId = "t1";
    expect(museUsageFrame(state, 10)).toBeUndefined();
    framesOf(
        [
            {
                method: "session/tokenUsage",
                params: { turnId: "t1", promptTokens: 100, totalTokens: 120, usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40, reasoningTokens: 0, cacheReadTokens: 30, cacheWriteTokens: 10 } },
            },
            { method: "session/tokenUsage", params: { turnId: "t1", promptTokens: 50, totalTokens: 55, usage: { inputTokens: 50, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 } } },
            // Another turn's spend is not this one's.
            { method: "session/tokenUsage", params: { turnId: "t2", promptTokens: 999, totalTokens: 999, usage: { inputTokens: 999, outputTokens: 9, cachedTokens: 0, reasoningTokens: 0 } } },
        ],
        state,
    );
    expect(museUsageFrame(state, 1_234)).toEqual({ kind: "usage", inputTokens: 110, outputTokens: 25, cacheReadTokens: 30, cacheCreationTokens: 10, durationMs: 1_234 });
});

test("a planning phase holds its prose one message deep: the last message is the plan, earlier ones are flushed", () => {
    const state = museStreamState({ holdMessages: true });
    expect(
        framesOf(
            [
                { method: "item/delta", params: { sessionId: "s1", viewCursor: "v", itemId: "m1", field: "text", delta: "Looking" } },
                item("item/completed", { itemId: "m1", kind: "agentMessage", status: "completed", text: "Looking around." }),
                item("item/completed", { itemId: "m2", kind: "agentMessage", status: "completed", text: "1. Edit app.ts" }),
            ],
            state,
        ),
    ).toEqual([{ kind: "delta", text: "Looking around." }, { kind: "text_end" }]);
    expect(state.planText).toBe("1. Edit app.ts");
});

describe("a failed turn is coded by Muse's type before its sentence", () => {
    it("codes a spent quota as rate_limit", () => {
        expect(museFailureFrame({ kind: "modelError", message: "quota", retryable: false, quota: { limitKind: "tierLimit", resetsAtMs: 1 } }, false).code).toBe(
            "rate_limit",
        );
    });

    it("codes a window the session outgrew as context-overflow", () => {
        expect(museFailureFrame({ kind: "modelError", message: "context_length_exceeded: prompt is too long", retryable: false }, false).code).toBe("context-overflow");
    });

    it("codes a model call Muse retried and could not get through as an outage auto-resume re-runs", () => {
        expect(museFailureFrame({ kind: "modelError", message: "stream disconnected", retryable: false }, true).code).toBe("provider-outage");
        expect(museFailureFrame({ kind: "modelError", message: "upstream 503", retryable: true }, false).code).toBe("provider-outage");
    });

    it("says where to reconnect when the key was refused, and codes nothing it cannot back", () => {
        const refused = museFailureFrame({ kind: "authRequired", message: "your API key from META_API_KEY was rejected", retryable: false }, false);
        expect(refused.code).toBeUndefined();
        expect(refused.message).toContain("Connect the account again");
        expect(museFailureFrame({ kind: "configError", message: "bad settings", retryable: false }, false).code).toBeUndefined();
    });
});

test("a notification the loop does not act on, or one it cannot read, is dropped at the boundary", () => {
    expect(readMuseEvent({ method: "skill/changed", params: {} })).toBeUndefined();
    expect(readMuseEvent({ method: "item/started", params: { item: { kind: "toolCall" } } })).toBeUndefined();
    expect(readMuseEvent({ method: "item/delta", params: { itemId: "m1", delta: "x" } })).toEqual({ method: "item/delta", params: { itemId: "m1", field: "text", delta: "x" } });
});
