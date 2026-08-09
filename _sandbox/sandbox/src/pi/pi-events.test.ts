import { expect, test } from "vitest";
import { createPiEventMapper, type PiTurnCapture } from "./pi-events.js";

/* The Pi event → AgentEvent mapping, exercised as the pure table it is — one Pi RPC event in, its frames
 * out. The adapter's loop (pi-agent.test.ts) trusts these shapes, so drift between Pi's wire vocabulary and
 * the contract's is caught here, next to the mapping that owns it. */

const CWD = "/work";

test("assistant text streams as deltas with a text_end boundary; thinking rides its own frame", () => {
    const mapper = createPiEventMapper(CWD);

    expect(mapper.map({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } })).toEqual([
        { kind: "thinking", text: "hmm" },
    ]);
    expect(mapper.map({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } })).toEqual([
        { kind: "delta", text: "Hello " },
    ]);
    expect(mapper.map({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "Hello world" } })).toEqual([
        { kind: "text_end" },
    ]);
    // Empty deltas and argument streaming have no UI mapping.
    expect(mapper.map({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } })).toEqual([]);
    expect(mapper.map({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: '{"co' } })).toEqual([]);
});

test("a plan capture holds text back instead of streaming it", () => {
    const capture: PiTurnCapture = {};
    const mapper = createPiEventMapper(CWD, capture);

    expect(mapper.map({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "1. Do the" } })).toEqual([]);
    expect(mapper.map({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " thing" } })).toEqual([]);
    expect(mapper.map({ type: "message_update", assistantMessageEvent: { type: "text_end" } })).toEqual([]);
    expect(capture.planText).toBe("1. Do the thing");
});

test("a tool call maps start → streamed output → completion, deriving the edit diff from its args", () => {
    const mapper = createPiEventMapper(CWD);

    expect(mapper.map({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "pnpm test" } })).toEqual([
        { kind: "tool_call", id: "c1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
    ]);
    expect(mapper.map({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [{ type: "text", text: "1 passed" }] } })).toEqual(
        [{ kind: "tool_call_update", id: "c1", content: [{ type: "text", text: "1 passed" }] }],
    );
    expect(
        mapper.map({
            type: "tool_execution_end",
            toolCallId: "c1",
            toolName: "bash",
            isError: false,
            result: { content: [{ type: "text", text: "1 passed" }] },
        }),
    ).toEqual([{ kind: "tool_call_update", id: "c1", status: "completed", content: [{ type: "text", text: "1 passed" }] }]);

    // An edit's completion carries structured diffs derived from its (final) input, one per hunk — Pi's edit
    // takes `{path, edits: [{oldText, newText}]}` — with the path workspace-relative.
    expect(
        mapper.map({
            type: "tool_execution_start",
            toolCallId: "c2",
            toolName: "edit",
            args: {
                path: "src/app.ts",
                edits: [
                    { oldText: "a", newText: "b" },
                    { oldText: "c", newText: "d" },
                ],
            },
        }),
    ).toEqual([
        {
            kind: "tool_call",
            id: "c2",
            name: "Edit",
            category: "edit",
            status: "in_progress",
            target: "src/app.ts",
            locations: [{ path: "src/app.ts" }],
        },
    ]);
    const end = mapper.map({ type: "tool_execution_end", toolCallId: "c2", toolName: "edit", isError: false, result: { content: [] } });
    expect(end).toEqual([
        {
            kind: "tool_call_update",
            id: "c2",
            status: "completed",
            content: [
                { type: "diff", path: "src/app.ts", oldText: "a", newText: "b" },
                { type: "diff", path: "src/app.ts", oldText: "c", newText: "d" },
            ],
        },
    ]);

    // A write is one whole-file diff derived from its `{path, content}` input.
    mapper.map({ type: "tool_execution_start", toolCallId: "c3", toolName: "write", args: { path: "notes.md", content: "hello" } });
    expect(mapper.map({ type: "tool_execution_end", toolCallId: "c3", toolName: "write", isError: false, result: { content: [] } })).toEqual([
        { kind: "tool_call_update", id: "c3", status: "completed", content: [{ type: "diff", path: "notes.md", newText: "hello" }] },
    ]);
});

test("a failing tool reports failed with its error text; a call first seen at its end arrives whole", () => {
    const mapper = createPiEventMapper(CWD);
    mapper.map({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "boom" } });
    expect(
        mapper.map({
            type: "tool_execution_end",
            toolCallId: "c1",
            toolName: "bash",
            isError: true,
            result: { content: [{ type: "text", text: "exit 1" }] },
        }),
    ).toEqual([{ kind: "tool_call_update", id: "c1", status: "failed", content: [{ type: "text", text: "exit 1" }] }]);

    expect(
        mapper.map({
            type: "tool_execution_end",
            toolCallId: "ghost",
            toolName: "read",
            isError: false,
            result: { content: [{ type: "text", text: "…" }] },
        }),
    ).toEqual([{ kind: "tool_call", id: "ghost", name: "Read", category: "read", status: "completed", content: [{ type: "text", text: "…" }] }]);
});

test("assistant usage sums across messages into one frame; an error stop surfaces as an error", () => {
    const capture: PiTurnCapture = {};
    const mapper = createPiEventMapper(CWD, capture);

    expect(
        mapper.map({
            type: "message_end",
            message: {
                role: "assistant",
                stopReason: "toolUse",
                usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 2, cost: { total: 0.01 } },
            },
        }),
    ).toEqual([]);
    mapper.map({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } },
    });
    expect(mapper.usage()).toEqual({
        kind: "usage",
        inputTokens: 150,
        outputTokens: 30,
        cacheReadTokens: 5,
        cacheCreationTokens: 2,
        costUsd: 0.03,
    });

    expect(mapper.map({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" } })).toEqual([
        { kind: "error", message: "overloaded" },
    ]);
    expect(capture.errored).toBe(true);
});

test("a mapper that saw no usage emits no usage frame", () => {
    expect(createPiEventMapper(CWD).usage()).toBeUndefined();
});

test("auto-retry surfaces as provider_retry, and a spent retry budget as the turn's error", () => {
    const mapper = createPiEventMapper(CWD);

    const [retry] = mapper.map({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529" });
    expect(retry).toMatchObject({ kind: "provider_retry", attempt: 1, maxAttempts: 3 });
    expect((retry as { nextAttemptAt?: number }).nextAttemptAt).toBeGreaterThan(Date.now() - 1000);

    expect(mapper.map({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual([]);
    expect(mapper.map({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" })).toEqual([
        { kind: "error", message: "529 overloaded" },
    ]);
});

test("compaction reports its trigger and token movement; user echoes and lifecycle brackets are dropped", () => {
    const mapper = createPiEventMapper(CWD);

    expect(
        mapper.map({ type: "compaction_end", reason: "threshold", result: { tokensBefore: 150_000, estimatedTokensAfter: 32_000 }, aborted: false }),
    ).toEqual([{ kind: "compact", trigger: "threshold", preTokens: 150_000, postTokens: 32_000 }]);
    expect(mapper.map({ type: "compaction_end", reason: "manual", result: null, aborted: true })).toEqual([]);

    expect(mapper.map({ type: "message_end", message: { role: "user", content: "hi" } })).toEqual([]);
    for (const type of ["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "queue_update", "compaction_start"]) {
        expect(mapper.map({ type }), type).toEqual([]);
    }
});
