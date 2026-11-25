import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { dialectOf, GROK_DIALECT, KIMI_DIALECT } from "./index.js";
import { fixture, replay } from "./replay.testing.js";

// Recorded traffic replayed through each dialect (replay.testing.ts says where every fixture comes from).

const kinds = (frames: readonly { readonly event: AgentEvent }[], kind: AgentEvent["kind"]) => frames.map((frame) => frame.event).filter((event) => event.kind === kind);

test("a name with no dialect is plain ACP", () => {
    expect(dialectOf(undefined)).toBeUndefined();
    expect(dialectOf("gemini")).toBeUndefined();
    expect(dialectOf("grok")).toBe(GROK_DIALECT);
});

test("Grok's foreground subagent lands on its spawn call's card, with its own calls under it", () => {
    const { frames, reader } = replay(GROK_DIALECT, fixture("grok-1.0.46-subagent-foreground.jsonl"));
    // Every frame is the parent's: the child session's traffic is re-homed, never dropped.
    expect(new Set(frames.map((frame) => frame.sessionId))).toEqual(new Set(["session-1"]));
    expect(kinds(frames, "subagent")).toEqual([
        { kind: "subagent", id: "call-1", subagentKind: "subagent", agentType: "general-purpose", description: "Count note lines", model: "grok-4.7" },
    ]);
    const updates = kinds(frames, "subagent_update");
    expect(updates.at(-1)).toEqual({ kind: "subagent_update", id: "call-1", status: "completed", tokens: 13_778, summary: "4" });
    expect(updates).toContainEqual({ kind: "subagent_update", id: "call-1", status: "running", tokens: 4091, toolUses: 1, lastTool: "run_terminal_command" });
    const childCall = kinds(frames, "tool_call").find((event) => event.kind === "tool_call" && event.parentToolUseId === "call-1");
    expect(childCall).toMatchObject({ id: "subagent-1/call-2", category: "execute", target: "wc -l notes.txt" });
    expect(kinds(frames, "tool_call_update")).toContainEqual(expect.objectContaining({ id: "subagent-1/call-2", status: "completed", exitCode: 0 }));
    expect(reader.holding("session-1")).toBe(false);
});

test("a background subagent holds its parent's turn until it finishes", () => {
    const lines = fixture("grok-1.0.46-subagent-background.jsonl");
    const finished = lines.findIndex((line) => JSON.stringify(line.message).includes("subagent_finished"));
    const before = replay(GROK_DIALECT, lines, finished);
    expect(kinds(before.frames, "subagent")).toEqual([expect.objectContaining({ id: "call-1", background: true })]);
    expect(before.reader.holding("session-1")).toBe(true);
    expect(before.reader.live("session-1")).toEqual({ subagents: ["subagent-1"], tasks: [] });
    const after = replay(GROK_DIALECT, lines);
    expect(after.reader.holding("session-1")).toBe(false);
    expect(after.reader.live("session-1")).toEqual({ subagents: [], tasks: [] });
    expect(kinds(after.frames, "subagent_update").at(-1)).toMatchObject({ id: "call-1", status: "completed", summary: "notes.txt, README.md" });
});

test("a background task's ending is put on the card of the call that started it", () => {
    const lines = fixture("grok-background-task.jsonl");
    const completed = lines.findIndex((line) => line.message.method === "_x.ai/task_completed");
    expect(replay(GROK_DIALECT, lines, completed).reader.live("session-1").tasks).toEqual(["01a10366-1e7f-7191-bcd1-fac24585851f"]);
    const { frames, reader } = replay(GROK_DIALECT, lines, completed + 1);
    expect(frames.at(-1)?.event).toEqual({
        kind: "tool_call_update",
        id: "call-1",
        status: "completed",
        exitCode: 0,
        content: [{ type: "text", text: "Background task exited with code 0: Sleep then write bg-marker.txt" }],
    });
    expect(reader.live("session-1").tasks).toEqual([]);
    // It said it will wake the agent, so the session is held until that wake's turn completes.
    expect(reader.holding("session-1")).toBe(true);
    expect(replay(GROK_DIALECT, lines).reader.holding("session-1")).toBe(false);
});

test("Grok's subagents cancelled with the turn end as killed", () => {
    const { frames, reader } = replay(GROK_DIALECT, fixture("grok-1.0.46-subagent-stop.jsonl"));
    const ends = kinds(frames, "subagent_update").filter((event) => event.kind === "subagent_update" && event.status === "killed");
    expect(ends.length).toBeGreaterThanOrEqual(2);
    expect(reader.live("session-1").subagents).toEqual([]);
});

test("Grok's ask-user request is the shared question card, answered in Grok's own shape", () => {
    const { questions } = replay(GROK_DIALECT, fixture("grok-ask-user-question.jsonl"));
    expect(questions).toHaveLength(1);
    const [asked] = questions;
    const question = "Which test approach do you want for the subtract function?";
    expect(asked?.sessionId).toBe("session-1");
    expect(asked?.questions[0]).toMatchObject({ question, multiSelect: false });
    expect(asked?.questions[0]?.options.map((option) => option.label)).toEqual(["node:test (Recommended)", "Plain assert script", "Add a package.json and a test script"]);
    // The recorded answer Grok's own card sent.
    expect(asked?.answer({ kind: "question", requestId: "r", answers: { [question]: ["node:test (Recommended)"] } })).toEqual({
        outcome: "accepted",
        answers: { [question]: "node:test (Recommended)" },
    });
    expect(asked?.answer({ kind: "question", requestId: "r", answers: { [question]: ["Use vitest"] } })).toEqual({
        outcome: "accepted",
        answers: { [question]: "Other" },
        annotations: { [question]: { notes: "Use vitest" } },
    });
    expect(asked?.answer({ kind: "question", requestId: "r", cancelled: true })).toEqual({ outcome: "cancelled" });
    expect(asked?.cancelled).toEqual({ outcome: "cancelled" });
});

test("a Grok method that is not a question asks nothing, and its notifications are claimed", () => {
    expect(GROK_DIALECT.question?.("_x.ai/exit_plan_mode", { sessionId: "s", toolCallId: "c" })).toBeUndefined();
    const reader = GROK_DIALECT.reader();
    expect(reader.notification("_x.ai/queue/changed", { sessionId: "s", entries: [] })).toEqual([]);
    expect(reader.notification("_other/thing", {})).toBeUndefined();
});

test("a stop is probed with params naming no child, and only 'method not found' means unsupported", () => {
    for (const stop of [GROK_DIALECT.subagentStop, GROK_DIALECT.taskStop]) {
        expect(stop?.probe).toEqual({});
        expect(stop?.supported({ error: { code: -32_602, data: "missing field `subagentId`" } })).toBe(true);
        expect(stop?.supported({ result: { outcome: "not_found" } })).toBe(true);
        expect(stop?.supported({ error: { code: -32_601 } })).toBe(false);
    }
    expect(GROK_DIALECT.taskStop?.params("s", "t")).toEqual({ sessionId: "s", taskId: "t" });
    expect(GROK_DIALECT.subagentStop?.params("s", "a")).toEqual({ sessionId: "s", subagentId: "a" });
});

test("Kimi's shell answers become the card's exit code and output", () => {
    const { frames } = replay(KIMI_DIALECT, fixture("kimi-2.1.1-shell.jsonl"));
    const updates = kinds(frames, "tool_call_update");
    // A running call's streamed arguments are not shown as output.
    expect(updates[0]).toEqual({ kind: "tool_call_update", id: "call-1", status: "in_progress" });
    expect(updates[1]).toEqual({
        kind: "tool_call_update",
        id: "call-1",
        status: "failed",
        exitCode: 2,
        content: [{ type: "text", text: "ls: cannot access 'missing': No such file or directory" }],
    });
    expect(updates[2]).toEqual({ kind: "tool_call_update", id: "call-2", status: "completed", exitCode: 0 });
    expect(updates[3]).toEqual({ kind: "tool_call_update", id: "call-3", status: "failed", exitCode: 1 });
});
