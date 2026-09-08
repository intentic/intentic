import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteChildWork } from "./child-verification.js";
import {
    closeSubagents,
    listSubagentSessions,
    noteSpawnedChild,
    noteSubagentSpawn,
    noteSubagentTask,
    openSpawnedChild,
    pairLiveSubagents,
    resetSubagents,
    settleSpawnedChild,
    subagentCountsOf,
    subagentHooks,
    subagentInParentTree,
    subagentSource,
    waitForSubagent,
    type SubagentTaskMessage,
    type SubagentTurn,
} from "./subagents.js";

const turn = (): SubagentTurn => ({ conversationId: "conv-1", cwd: WORKSPACE_ROOT, sessionId: "sess-1", subagentsDir: undefined });

// A `task_started` as the SDK delivers it. An override explicitly set to `undefined` means the SDK sent the task
// without that field, distinct from the override being absent.
const started = (over: { [K in keyof SubagentTaskMessage]?: SubagentTaskMessage[K] | undefined } = {}): SubagentTaskMessage =>
    ({
        subtype: "task_started",
        task_id: "task-a",
        tool_use_id: "call-1",
        description: "Locate claimIndexer",
        subagent_type: "Explore",
        ...over,
    }) as SubagentTaskMessage;

// agent_transcript_path names the .jsonl; the registry actually reads its .meta.json sibling.
const stopped = async (dir: string, agentId: string, lastAssistantMessage?: string): Promise<void> => {
    await subagentHooks(turn()).SubagentStop?.[0]?.hooks[0]?.(
        {
            hook_event_name: "SubagentStop",
            agent_transcript_path: join(dir, `agent-${agentId}.jsonl`),
            agent_id: agentId,
            ...(lastAssistantMessage !== undefined ? { last_assistant_message: lastAssistantMessage } : {}),
        } as unknown as HookInput,
        "t1",
        { signal: new AbortController().signal },
    );
};

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

    // Neither field rides a task_updated patch; both must come off the spawning call instead.
    it("takes 'backgrounded' and the model from the spawning tool call, onto the frame that announces the child", () => {
        noteSubagentSpawn("call-1", { background: true, model: "sonnet" });
        expect(noteSubagentTask(turn(), started())).toMatchObject({ kind: "subagent", id: "call-1", background: true, model: "sonnet" });
        expect(listSubagentSessions()).toMatchObject([{ id: "call-1", background: true, model: "sonnet" }]);
    });

    // `background: false` and `model: "inherit"` both leave the field unset, not false or "inherit".
    it("leaves an unmarked child without the flag, and a child that named no model without one", () => {
        noteSubagentSpawn("call-1", { background: false, model: "inherit" });
        expect(noteSubagentTask(turn(), started())).not.toHaveProperty("background");
        expect(listSubagentSessions()[0]).not.toHaveProperty("background");
        expect(listSubagentSessions()[0]).not.toHaveProperty("model");
    });

    // A meta file's model surfaces only when the spawning call named none.
    it("takes the model from the meta file for a child whose call named none", async () => {
        const dir = await mkdtemp(join(tmpdir(), "subagents-model-"));
        await writeFile(join(dir, "agent-xyz.meta.json"), JSON.stringify({ toolUseId: "call-1", model: "claude-haiku-4-5-20251001" }));
        await writeFile(join(dir, "agent-abc.meta.json"), JSON.stringify({ toolUseId: "call-2", model: "inherit" }));
        noteSubagentTask(turn(), started());
        noteSubagentTask(turn(), started({ tool_use_id: "call-2", task_id: "task-b" }));
        await stopped(dir, "xyz");
        await stopped(dir, "abc");
        const byId = new Map(listSubagentSessions().map((session) => [session.id, session]));
        expect(byId.get("call-1")).toMatchObject({ model: "claude-haiku-4-5-20251001" });
        expect(byId.get("call-2")).not.toHaveProperty("model");
    });

    // pairLiveSubagents is the only source of a model for a child the daemon never saw spawned.
    it("pairs a child that is still working when the roster is read", async () => {
        const dir = await mkdtemp(join(tmpdir(), "subagents-live-"));
        noteSubagentTask({ conversationId: "conv-1", cwd: WORKSPACE_ROOT, sessionId: "sess-1", subagentsDir: dir }, started());
        await writeFile(join(dir, "agent-live.meta.json"), JSON.stringify({ toolUseId: "call-1", model: "sonnet", spawnDepth: 2 }));
        await pairLiveSubagents();
        expect(listSubagentSessions()[0]).toMatchObject({ id: "call-1", status: "running", model: "sonnet", spawnDepth: 2 });
        // Deleted to prove the model came from the earlier cached read, not a fresh one.
        await rm(join(dir, "agent-live.meta.json"));
        await pairLiveSubagents();
        expect(listSubagentSessions()[0]).toMatchObject({ model: "sonnet" });
    });

    it("skips a task with no tool_use id, and an ambient one", () => {
        expect(noteSubagentTask(turn(), started({ tool_use_id: undefined }))).toBeUndefined();
        expect(noteSubagentTask(turn(), started({ skip_transcript: true }))).toBeUndefined();
        expect(listSubagentSessions()).toEqual([]);
    });

    it("files agent tasks only, not the shell/monitor/workflow work the same stream carries", () => {
        expect(
            noteSubagentTask(turn(), started({ subagent_type: undefined, task_type: "local_bash", description: "Run full web suite" })),
        ).toBeUndefined();
        expect(noteSubagentTask(turn(), started({ tool_use_id: "call-2", subagent_type: undefined, task_type: "monitor_ws" }))).toBeUndefined();
        expect(noteSubagentTask(turn(), started({ tool_use_id: "call-3", subagent_type: undefined, task_type: "local_workflow" }))).toBeUndefined();
        expect(noteSubagentTask(turn(), started({ tool_use_id: "call-4", subagent_type: undefined }))).toBeUndefined();
        expect(listSubagentSessions()).toEqual([]);
        expect(noteSubagentTask(turn(), started({ tool_use_id: "call-5", subagent_type: undefined, task_type: "local_agent" }))).toMatchObject({
            kind: "subagent",
            id: "call-5",
        });
        expect(listSubagentSessions().map((session) => session.id)).toEqual(["call-5"]);
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

    it("reads the turn's session id as it stands, not as it was when the child was born", () => {
        const handle: SubagentTurn = { conversationId: "conv-1", cwd: WORKSPACE_ROOT, sessionId: undefined, subagentsDir: undefined };
        noteSubagentTask(handle, started());
        handle.sessionId = "sess-late";
        expect(subagentSource("call-1")).toMatchObject({ sessionId: "sess-late" });
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

    it("counts only tree-sharing children for the rebase gate", () => {
        openSpawnedChild(turn(), { id: "sub-own-tree", description: "port it" });
        expect(subagentInParentTree("conv-1")).toBe(false);
        noteSubagentTask(turn(), started());
        expect(subagentInParentTree("conv-1")).toBe(true);
        noteSubagentTask(turn(), { subtype: "task_updated", task_id: "task-a", patch: { status: "completed" } });
        expect(subagentInParentTree("conv-1")).toBe(false);
    });

    it("kills whatever is still live when the turn ends", () => {
        noteSubagentTask(turn(), started());
        noteSubagentTask(turn(), started({ tool_use_id: "call-9", task_id: "task-b" }));
        noteSubagentTask({ ...turn(), conversationId: "conv-2" }, started({ tool_use_id: "other", task_id: "task-z" }));
        expect(closeSubagents("conv-1").map((frame) => update(frame).id)).toEqual(["call-1", "call-9"]);
        expect(
            listSubagentSessions()
                .filter((session) => session.status === "running")
                .map((session) => session.id),
        ).toEqual(["other"]);
        expect(closeSubagents("conv-1")).toEqual([]);
    });

    // Retain window asserted from both sides (still listed at 4 min, gone by 6): the boundary is pinned, not
    // incidental.
    it("ages a finished child out of the list after five minutes, and keeps a live one", () => {
        vi.useFakeTimers();
        noteSubagentTask(turn(), started());
        noteSubagentTask(turn(), started({ tool_use_id: "live-1", task_id: "task-b" }));
        noteSubagentTask(turn(), { subtype: "task_updated", task_id: "task-a", patch: { status: "completed" } });
        vi.advanceTimersByTime(4 * 60_000);
        expect(listSubagentSessions().map((session) => session.id)).toEqual(["live-1", "call-1"]);
        vi.advanceTimersByTime(2 * 60_000);
        expect(listSubagentSessions().map((session) => session.id)).toEqual(["live-1"]);
    });
});

// Children the daemon runs directly (children/children.ts), driven through the same entry points the service calls:
// filed under their parent, carrying their provider, and outliving the parent's turn.
describe("spawned children", () => {
    const birth = { id: "sub-brave-otter-a1b2", description: "Port the parser", agentType: "Cursor", provider: "cursor", model: "composer-2.5" };

    it("lists a spawned child under its parent, backgrounded, wearing its provider", () => {
        openSpawnedChild(turn(), { ...birth, harness: "native", spawnDepth: 1 });
        const [session] = listSubagentSessions();
        expect(session).toMatchObject({
            id: "sub-brave-otter-a1b2",
            kind: "spawned",
            conversationId: "conv-1",
            agentType: "Cursor",
            provider: "cursor",
            model: "composer-2.5",
            spawnDepth: 1,
            background: true,
            status: "running",
        });
        expect(subagentCountsOf("conv-1")).toEqual({ running: 1, total: 1 });
    });

    it("reports blocked with what it waits on, and running again once answered", () => {
        openSpawnedChild(turn(), birth);
        noteSpawnedChild(birth.id, { status: "blocked", summary: "Which port should the server bind?" });
        expect(listSubagentSessions()[0]).toMatchObject({ status: "blocked", summary: "Which port should the server bind?" });
        noteSpawnedChild(birth.id, { status: "running" });
        expect(listSubagentSessions()[0]?.status).toBe("running");
    });

    it("outlives the parent's turn: close kills the SDK child and leaves the spawned one working", () => {
        noteSubagentTask(turn(), started());
        openSpawnedChild(turn(), birth);
        expect(closeSubagents("conv-1").map((frame) => update(frame).id)).toEqual(["call-1"]);
        expect(listSubagentSessions().find((session) => session.id === birth.id)?.status).toBe("running");
    });

    it("settles with the head of the child's closing text, and wakes a parked wait", async () => {
        openSpawnedChild(turn(), birth);
        const parked = waitForSubagent("conv-1", { target: birth.id, until: ["finished"], timeoutMs: 5_000 });
        settleSpawnedChild(birth.id, { failed: false, report: "The parser now handles nested arrays. Two files changed." });
        await expect(parked).resolves.toMatchObject({
            outcome: "finished",
            matched: { id: birth.id, status: "completed", summary: "The parser now handles nested arrays. Two files changed." },
        });
    });

    it("keeps a failure's error beside whatever it managed to say", () => {
        openSpawnedChild(turn(), birth);
        settleSpawnedChild(birth.id, { failed: true, report: "Got as far as the lexer.", error: "provider refused the model" });
        expect(listSubagentSessions()[0]).toMatchObject({
            status: "failed",
            summary: "Got as far as the lexer.",
            error: "provider refused the model",
        });
    });

    it("hands the transcript reader the child's conversation key", () => {
        openSpawnedChild(turn(), { ...birth, harness: "native" });
        expect(subagentSource(birth.id)).toMatchObject({ kind: "spawned", conversationId: "conv-1", provider: "cursor", harness: "native" });
    });

    it("reopens a settled child for a follow-up turn, and never replaces a live one", () => {
        openSpawnedChild(turn(), birth);
        settleSpawnedChild(birth.id, { failed: false, report: "first pass done" });
        openSpawnedChild(turn(), { ...birth, description: "also handle nested arrays" });
        expect(listSubagentSessions()[0]).toMatchObject({ id: birth.id, status: "running", description: "also handle nested arrays" });
        openSpawnedChild(turn(), { ...birth, description: "a third ask" });
        expect(listSubagentSessions()[0]).toMatchObject({ description: "also handle nested arrays" });
    });

    it("drops a late move from a child already settled", () => {
        openSpawnedChild(turn(), birth);
        settleSpawnedChild(birth.id, { failed: false, report: "done" });
        noteSpawnedChild(birth.id, { status: "blocked", summary: "too late" });
        expect(listSubagentSessions()[0]).toMatchObject({ status: "completed", summary: "done" });
    });
});

// Pins herdr's wait discipline: subscribe before the first look so nothing lands in the gap, evaluate synchronously
// inside every transition so a flicker still counts, and a timeout is an answer, not an error.
describe("waitForSubagent", () => {
    const spawn = (id: string): void => {
        openSpawnedChild(turn(), { id, description: "do the thing", provider: "claude" });
    };

    it("resolves immediately when the target already satisfies the wait", async () => {
        spawn("bash-1");
        settleSpawnedChild("bash-1", { failed: false, report: "done" });
        const result = await waitForSubagent("conv-1", { target: "bash-1", until: ["finished"], timeoutMs: 5_000 });
        expect(result).toMatchObject({ outcome: "finished", matched: { id: "bash-1", status: "completed" } });
    });

    it("wakes when the child blocks", async () => {
        spawn("bash-1");
        const wait = waitForSubagent("conv-1", { target: "bash-1", until: ["blocked", "finished"], timeoutMs: 5_000 });
        noteSpawnedChild("bash-1", { status: "blocked" });
        expect(await wait).toMatchObject({ outcome: "blocked", matched: { id: "bash-1", status: "blocked" } });
    });

    it("a blocked flicker still wakes the waiter: the listener runs inside the transition, not after it", async () => {
        spawn("bash-1");
        const wait = waitForSubagent("conv-1", { target: "bash-1", until: ["blocked"], timeoutMs: 5_000 });
        noteSpawnedChild("bash-1", { status: "blocked" });
        noteSpawnedChild("bash-1", { status: "running" });
        expect(await wait).toMatchObject({ outcome: "blocked" });
    });

    it("with no target, the first of the conversation's children to move settles the wait: other conversations' don't", async () => {
        spawn("bash-1");
        openSpawnedChild(
            { conversationId: "conv-2", cwd: WORKSPACE_ROOT, sessionId: "sess-2", subagentsDir: undefined },
            { id: "bash-other", description: "elsewhere" },
        );
        const wait = waitForSubagent("conv-1", { until: ["blocked"], timeoutMs: 5_000 });
        noteSpawnedChild("bash-other", { status: "blocked" });
        noteSpawnedChild("bash-1", { status: "blocked" });
        expect(await wait).toMatchObject({ outcome: "blocked", matched: { id: "bash-1" } });
    });

    it("a timeout answers with the target's current snapshot", async () => {
        spawn("bash-1");
        const result = await waitForSubagent("conv-1", { target: "bash-1", until: ["blocked"], timeoutMs: 20 });
        expect(result).toMatchObject({ outcome: "timeout", matched: { id: "bash-1", status: "running" } });
    });

    it("the turn's abort settles the wait", async () => {
        spawn("bash-1");
        const controller = new AbortController();
        const wait = waitForSubagent("conv-1", { target: "bash-1", until: ["blocked"], timeoutMs: 5_000, signal: controller.signal });
        controller.abort();
        expect(await wait).toMatchObject({ outcome: "aborted" });
    });

    it("a target the roster does not know answers unknown-target instead of hanging", async () => {
        const result = await waitForSubagent("conv-1", { target: "never-was", until: ["finished"], timeoutMs: 5_000 });
        expect(result).toMatchObject({ outcome: "unknown-target" });
    });

    it("answers immediately when nothing live could ever satisfy the wait", async () => {
        expect(await waitForSubagent("conv-1", { until: ["blocked"], timeoutMs: 5_000 })).toMatchObject({ outcome: "unknown-target" });
        spawn("bash-1");
        settleSpawnedChild("bash-1", { failed: false, report: "done" });
        expect(await waitForSubagent("conv-1", { target: "bash-1", until: ["blocked"], timeoutMs: 5_000 })).toMatchObject({
            outcome: "unknown-target",
            matched: { id: "bash-1", status: "completed" },
        });
    });

    it("still waits while the child is live", async () => {
        spawn("bash-1");
        const wait = waitForSubagent("conv-1", { target: "bash-1", until: ["finished"], timeoutMs: 5_000 });
        settleSpawnedChild("bash-1", { failed: false, report: "done" });
        expect(await wait).toMatchObject({ outcome: "finished" });
    });
});

// The one ending rule: first arrival ends a child, a later arrival may only turn a finished child into a failed one,
// and the summary is kept by source rather than by whoever spoke last.
describe("how a subagent ends", () => {
    it("keeps an SDK child's own last words over the task stream's later digest", async () => {
        const dir = await mkdtemp(join(tmpdir(), "subagents-ending-"));
        await writeFile(join(dir, "agent-xyz.meta.json"), JSON.stringify({ toolUseId: "call-1", agentType: "Explore" }));
        noteSubagentTask(turn(), started());
        await stopped(dir, "xyz", "Found it in the reducer.");
        // The SDK's exit notification lands afterwards with its own digest: the child's own words stand.
        noteSubagentTask(turn(), { subtype: "task_notification", tool_use_id: "call-1", status: "completed", summary: "ran 12 tools" });
        expect(listSubagentSessions()).toMatchObject([{ id: "call-1", status: "completed", summary: "Found it in the reducer." }]);
    });

    it("stamps the verification the moment it ends, whichever road it came down", () => {
        openSpawnedChild(turn(), { id: "sub-verify-1", description: "port the parser" });
        noteChildWork(
            { kind: "tool_call", id: "c1", name: "Edit", category: "edit", status: "completed", locations: [{ path: "src/parser.ts" }] },
            "sub-verify-1",
        );
        expect(listSubagentSessions()[0]?.verification).toBeUndefined();
        settleSpawnedChild("sub-verify-1", { failed: false, report: "Ported it." });
        expect(listSubagentSessions()[0]?.verification).toEqual({ state: "unproven", paths: ["src/parser.ts"] });
    });

    it("carries the verdict on the same frame as the report, for an SDK child too", () => {
        noteSubagentTask(turn(), started({ tool_use_id: "call-v" }));
        noteChildWork(
            { kind: "tool_call", id: "c1", name: "Write", category: "edit", status: "completed", locations: [{ path: "src/a.ts" }] },
            "call-v",
        );
        noteChildWork({ kind: "tool_call", id: "c2", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" }, "call-v");
        noteChildWork({ kind: "tool_call_update", id: "c2", status: "completed", content: [{ type: "text", text: "--- [exit 0, 2s]" }] }, undefined);
        const frame = update(noteSubagentTask(turn(), { subtype: "task_notification", tool_use_id: "call-v", status: "completed", summary: "done" }));
        expect(frame.verification).toEqual({ state: "verified", paths: ["src/a.ts"], check: "pnpm test" });
    });

    it("appends the warning to a Task result the parent is about to read", async () => {
        noteSubagentTask(turn(), started({ tool_use_id: "call-w" }));
        noteChildWork(
            { kind: "tool_call", id: "c1", name: "Edit", category: "edit", status: "completed", locations: [{ path: "src/a.ts" }] },
            "call-w",
        );
        const output = await subagentHooks(turn()).PostToolUse?.[0]?.hooks[0]?.(
            {
                hook_event_name: "PostToolUse",
                tool_name: "Task",
                tool_use_id: "call-w",
                tool_input: {},
                tool_response: "Done.",
            } as unknown as HookInput,
            "t1",
            { signal: new AbortController().signal },
        );
        expect((output as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext).toContain("UNPROVEN");
    });

    it("says nothing about a child that edited no code", async () => {
        noteSubagentTask(turn(), started({ tool_use_id: "call-q" }));
        noteChildWork({ kind: "tool_call", id: "c1", name: "Grep", category: "search", status: "completed", target: "needle" }, "call-q");
        const output = await subagentHooks(turn()).PostToolUse?.[0]?.hooks[0]?.(
            {
                hook_event_name: "PostToolUse",
                tool_name: "Task",
                tool_use_id: "call-q",
                tool_input: {},
                tool_response: "Found it.",
            } as unknown as HookInput,
            "t1",
            { signal: new AbortController().signal },
        );
        expect(output).toEqual({ continue: true });
    });

    it("does not re-end a finished child, but does let a late failure through", () => {
        openSpawnedChild(turn(), { id: "sub-late-1", description: "go" });
        settleSpawnedChild("sub-late-1", { failed: false, report: "All done." });
        expect(listSubagentSessions()).toMatchObject([{ id: "sub-late-1", status: "completed" }]);
        settleSpawnedChild("sub-late-1", { failed: false, report: "" });
        expect(listSubagentSessions()).toMatchObject([{ id: "sub-late-1", status: "completed" }]);
        settleSpawnedChild("sub-late-1", { failed: true, report: "", error: "exit 1" });
        expect(listSubagentSessions()).toMatchObject([{ id: "sub-late-1", status: "failed", summary: "All done.", error: "exit 1" }]);
    });
});
