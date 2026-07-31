import type { AgentEvent } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    closeSubagents,
    listSubagentSessions,
    noteDelegation,
    noteSubagentTask,
    resetSubagents,
    settleDelegation,
    subagentCountsOf,
    subagentSource,
    type SubagentTaskMessage,
    type SubagentTurn,
} from "./subagents.js";

const turn = (): SubagentTurn => ({ conversationId: "conv-1", cwd: "/work", sessionId: "sess-1" });

const started = (over: Partial<SubagentTaskMessage> = {}): SubagentTaskMessage => ({
    subtype: "task_started",
    task_id: "task-a",
    tool_use_id: "call-1",
    description: "Locate claimIndexer",
    subagent_type: "Explore",
    ...over,
});

const update = (frame: AgentEvent | undefined): Extract<AgentEvent, { kind: "subagent_update" }> => {
    if (frame?.kind !== "subagent_update") {
        throw new Error(`expected a subagent_update, got ${frame?.kind ?? "nothing"}`);
    }
    return frame;
};

beforeEach(() => resetSubagents());
afterEach(() => vi.useRealTimers());

describe("the SDK's own subagents", () => {
    it("opens a record from task_started and reports it as born", () => {
        const frame = noteSubagentTask(turn(), started());
        expect(frame).toEqual({
            kind: "subagent",
            id: "call-1",
            subagentKind: "subagent",
            agentType: "Explore",
            description: "Locate claimIndexer",
        });
        expect(listSubagentSessions()).toMatchObject([
            { id: "call-1", kind: "subagent", conversationId: "conv-1", agentType: "Explore", status: "running" },
        ]);
    });

    // The id is the SPAWNING TOOL CALL's, which is what makes the card and the record point at each other with no
    // correlation step — so a task with no tool_use id has no id to be listed under. The SDK's own note on
    // skip_transcript says as much: an ambient/housekeeping task is not a child anybody started.
    it("skips a task with no tool_use id, and an ambient one", () => {
        expect(noteSubagentTask(turn(), started({ tool_use_id: undefined }))).toBeUndefined();
        expect(noteSubagentTask(turn(), started({ skip_transcript: true }))).toBeUndefined();
        expect(listSubagentSessions()).toEqual([]);
    });

    it("folds progress onto the record and reports only what moved", () => {
        noteSubagentTask(turn(), started());
        const first = update(
            noteSubagentTask(turn(), {
                subtype: "task_progress",
                tool_use_id: "call-1",
                description: "Locate claimIndexer",
                usage: { total_tokens: 4200, tool_uses: 7 },
                last_tool_name: "Grep",
            }),
        );
        expect(first).toEqual({ kind: "subagent_update", id: "call-1", tokens: 4200, toolUses: 7, lastTool: "Grep" });
        // Nothing changed the second time, so there is no frame — a client that re-renders per update should not
        // be woken by a progress message that said the same thing again.
        expect(
            noteSubagentTask(turn(), {
                subtype: "task_progress",
                tool_use_id: "call-1",
                description: "Locate claimIndexer",
                usage: { total_tokens: 4200, tool_uses: 7 },
                last_tool_name: "Grep",
            }),
        ).toBeUndefined();
    });

    // task_updated names only its task_id, so the pairing task_started established is what resolves it.
    it("resolves task_updated through the task id, and stamps the end", () => {
        noteSubagentTask(turn(), started());
        expect(update(noteSubagentTask(turn(), { subtype: "task_updated", task_id: "task-a", patch: { status: "completed" } }))).toEqual({
            kind: "subagent_update",
            id: "call-1",
            status: "completed",
        });
        const [record] = listSubagentSessions();
        expect(record?.status).toBe("completed");
        expect(record?.endedAt).toBeGreaterThan(0);
    });

    // "stopped" is the SDK's word for a child cut short; ours is `killed`. A status neither vocabulary knows
    // leaves the record where it was rather than being coerced into a wrong one.
    it("maps a notification's terminal status and keeps its report", () => {
        noteSubagentTask(turn(), started());
        expect(
            update(noteSubagentTask(turn(), { subtype: "task_notification", tool_use_id: "call-1", status: "stopped", summary: "cut short" })),
        ).toMatchObject({ status: "killed", summary: "cut short" });
        noteSubagentTask(turn(), started({ tool_use_id: "call-2", task_id: "task-b" }));
        expect(noteSubagentTask(turn(), { subtype: "task_updated", task_id: "task-b", patch: { status: "reticulating" } })).toBeUndefined();
        expect(listSubagentSessions().find((session) => session.id === "call-2")?.status).toBe("running");
    });

    it("hands the reader the ids a transcript is read with", () => {
        noteSubagentTask(turn(), started());
        expect(subagentSource("call-1")).toMatchObject({ kind: "subagent", conversationId: "conv-1", sessionId: "sess-1", running: true });
        expect(subagentSource("nobody")).toBeUndefined();
    });
});

describe("delegations", () => {
    it("files a codex exec as an agent, with the prompt as its description", () => {
        const frame = noteDelegation(turn(), {
            id: "bash-1",
            command: "codex exec --sandbox danger-full-access --cd /work 'Port the auth module to the new client'",
            terminal: "agent-abc12345",
        });
        expect(frame).toEqual({
            kind: "subagent",
            id: "bash-1",
            subagentKind: "codex",
            agentType: "Codex",
            description: "Port the auth module to the new client",
            terminal: "agent-abc12345",
        });
    });

    it("recognizes an opencode run and remembers the session a continue names", () => {
        noteDelegation(turn(), { id: "bash-2", command: "XDG_DATA_HOME=/agent-auth opencode run --session ses_7f3 --model xai/grok-4 'keep going'" });
        expect(subagentSource("bash-2")).toMatchObject({ kind: "grok", thread: "ses_7f3" });
    });

    // A resumed thread is the same agent carrying on, so it updates the record it names rather than opening a
    // second one — and a command that merely MENTIONS a delegation verb is not an agent at all.
    it("takes the thread id off a resume, and ignores a command that only mentions codex", () => {
        noteDelegation(turn(), { id: "bash-3", command: "codex exec --sandbox danger-full-access resume 019fb7fd-349b-7571 'and now the tests'" });
        expect(subagentSource("bash-3")).toMatchObject({ kind: "codex", thread: "019fb7fd-349b-7571" });
        expect(noteDelegation(turn(), { id: "bash-4", command: "grep -rn 'codex exec' docs/" })).toBeUndefined();
        expect(noteDelegation(turn(), { id: "bash-5", command: "echo how to codex" })).toBeUndefined();
        expect(listSubagentSessions().map((session) => session.id)).toEqual(["bash-3"]);
    });

    it("settles on the command's result, taking its tail as the report", () => {
        noteDelegation(turn(), { id: "bash-6", command: "codex exec 'audit the gate'" });
        expect(update(settleDelegation("bash-6", { failed: false, output: "  looked at 4 files\nthe gate is fine  " }))).toMatchObject({
            status: "completed",
            summary: "looked at 4 files\nthe gate is fine",
        });
        expect(settleDelegation("never-started", { failed: false, output: "x" })).toBeUndefined();
    });

    it("reports a failed delegation's tail as the error too", () => {
        noteDelegation(turn(), { id: "bash-7", command: "codex exec 'audit the gate'" });
        expect(update(settleDelegation("bash-7", { failed: true, output: "not logged in" }))).toMatchObject({
            status: "failed",
            error: "not logged in",
        });
    });
});

describe("the roster", () => {
    it("counts a conversation's own children, live and total", () => {
        noteSubagentTask(turn(), started());
        noteSubagentTask(turn(), started({ tool_use_id: "call-2", task_id: "task-b" }));
        noteSubagentTask(turn(), { subtype: "task_updated", task_id: "task-b", patch: { status: "completed" } });
        noteSubagentTask({ ...turn(), conversationId: "conv-2" }, started({ tool_use_id: "call-3", task_id: "task-c" }));
        expect(subagentCountsOf("conv-1")).toEqual({ running: 1, total: 2 });
        expect(subagentCountsOf("conv-3")).toEqual({ running: 0, total: 0 });
    });

    it("lists live children first, then the most recently active", () => {
        noteSubagentTask(turn(), started({ tool_use_id: "done-1", task_id: "task-a" }));
        noteSubagentTask(turn(), { subtype: "task_updated", task_id: "task-a", patch: { status: "completed" } });
        noteSubagentTask(turn(), started({ tool_use_id: "live-1", task_id: "task-b" }));
        expect(listSubagentSessions().map((session) => session.id)).toEqual(["live-1", "done-1"]);
    });

    // A stopped turn reports no terminal status for the children it was running, so the turn's end is what
    // settles them — a child left "running" forever is the lie this registry exists to remove.
    it("kills whatever is still live when the turn ends", () => {
        noteSubagentTask(turn(), started());
        noteDelegation(turn(), { id: "bash-1", command: "codex exec 'go'" });
        noteSubagentTask({ ...turn(), conversationId: "conv-2" }, started({ tool_use_id: "other", task_id: "task-z" }));
        expect(closeSubagents("conv-1").map((frame) => update(frame).id)).toEqual(["call-1", "bash-1"]);
        expect(
            listSubagentSessions()
                .filter((session) => session.status === "running")
                .map((session) => session.id),
        ).toEqual(["other"]);
        // Nothing left live in that conversation, so a second close says nothing.
        expect(closeSubagents("conv-1")).toEqual([]);
    });

    it("ages a finished child out of the list, and keeps a live one", () => {
        vi.useFakeTimers();
        noteSubagentTask(turn(), started());
        noteSubagentTask(turn(), started({ tool_use_id: "live-1", task_id: "task-b" }));
        noteSubagentTask(turn(), { subtype: "task_updated", task_id: "task-a", patch: { status: "completed" } });
        vi.advanceTimersByTime(3 * 3_600_000);
        expect(listSubagentSessions().map((session) => session.id)).toEqual(["live-1"]);
    });
});
