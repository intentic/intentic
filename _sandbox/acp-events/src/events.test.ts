import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { sessionUpdateEvent } from "./events.js";

// The reading with no caller's places in it: paths against the turn's folder alone. The daemon's suite holds the rest
// of the mapping through its own wrapper (sandbox runtimes/acp/acp-events.test.ts).

const CWD = "/home/ada/shop";

test("an agent's words and thoughts become text frames, and an empty chunk nothing", () => {
    expect(sessionUpdateEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }, CWD)).toEqual({ kind: "delta", text: "Done." });
    expect(sessionUpdateEvent({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hm." } }, CWD)).toEqual({ kind: "thinking", text: "Hm." });
    expect(sessionUpdateEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }, CWD)).toBeUndefined();
});

test("a tool call's files and diffs are read against the turn's folder", () => {
    const opened: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Edit src/app.ts",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/home/ada/shop/src/app.ts", line: 7 }, { path: "/etc/hosts" }],
        content: [{ type: "diff", path: "/home/ada/shop/src/app.ts", oldText: "a", newText: "b" }],
    };
    expect(sessionUpdateEvent(opened, CWD)).toMatchObject({
        kind: "tool_call",
        id: "t1",
        category: "edit",
        status: "pending",
        locations: [{ path: "src/app.ts", line: 7 }],
        content: [{ type: "diff", path: "src/app.ts", oldText: "a", newText: "b" }],
    });
});

test("a caller's own reading of paths and of its terminals wins over the defaults", () => {
    const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "t2",
        status: "completed",
        locations: [{ path: "/outside/notes.md" }],
        content: [{ type: "terminal", terminalId: "term-1" }],
    };
    expect(sessionUpdateEvent(update, CWD)).toEqual({
        kind: "tool_call_update",
        id: "t2",
        status: "completed",
        content: [{ type: "text", text: "[running in the live terminal panel]" }],
    });
    expect(sessionUpdateEvent(update, CWD, { pathOf: () => "linked/notes.md", terminalExit: (id) => (id === "term-1" ? 2 : undefined) })).toMatchObject({
        locations: [{ path: "linked/notes.md" }],
        exitCode: 2,
    });
});

test("a call that names no kind is read off its title, and a checklist becomes todos", () => {
    expect(sessionUpdateEvent({ sessionUpdate: "tool_call", toolCallId: "t3", title: "Bash" }, CWD)).toMatchObject({
        kind: "tool_call",
        category: "execute",
        status: "in_progress",
    });
    expect(sessionUpdateEvent({ sessionUpdate: "tool_call", toolCallId: "t4", title: "Bash", kind: "fetch" }, CWD)).toMatchObject({ category: "fetch" });
    expect(sessionUpdateEvent({ sessionUpdate: "plan", entries: [{ content: "Read it", status: "completed", priority: "high" }] }, CWD)).toEqual({
        kind: "todos",
        items: [{ content: "Read it", status: "completed" }],
    });
});

test("the agent's own commands carry a hint only where it gives one, and an update the chat does not draw is dropped", () => {
    expect(
        sessionUpdateEvent(
            { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review the diff" }, { name: "test", description: "Run tests", input: { hint: "[path]" } }] },
            CWD,
        ),
    ).toEqual({ kind: "commands", items: [{ name: "review", description: "Review the diff" }, { name: "test", description: "Run tests", hint: "[path]" }] });
    expect(sessionUpdateEvent({ sessionUpdate: "current_mode_update", currentModeId: "plan" }, CWD)).toBeUndefined();
    expect(sessionUpdateEvent({ sessionUpdate: "usage_update", used: 0, size: 0 }, CWD)).toBeUndefined();
});
