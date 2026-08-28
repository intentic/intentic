import { mkdtemp, writeFile } from "node:fs/promises";
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
    resetSubagents,
    settleSpawnedChild,
    subagentAgentId,
    subagentCountsOf,
    subagentHooks,
    subagentInParentTree,
    subagentSource,
    waitForSubagent,
    type SubagentTaskMessage,
    type SubagentTurn,
} from "./subagents.js";

const turn = (): SubagentTurn => ({ conversationId: "conv-1", cwd: WORKSPACE_ROOT, sessionId: "sess-1", subagentsDir: undefined });

// A `task_started` as the SDK delivers it. An override spelled out as `undefined` states that the SDK sent the
// task WITHOUT that field: the case two of these suites are about, which is why the override map admits
// undefined where SubagentTaskMessage's own optional fields do not.
const started = (over: { [K in keyof SubagentTaskMessage]?: SubagentTaskMessage[K] | undefined } = {}): SubagentTaskMessage =>
    ({
        subtype: "task_started",
        task_id: "task-a",
        tool_use_id: "call-1",
        description: "Locate claimIndexer",
        subagent_type: "Explore",
        ...over,
    }) as SubagentTaskMessage;

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

    /* THE ONE FACT THE TASK STREAM NEVER CARRIES. A child the parent walked away from is `is_backgrounded` on a
     * task_updated patch that does not come: a real backgrounded child was watched through birth, work, report
     * and death without it arriving once, so the spawning tool call is where it comes from instead. The mark is
     * laid before the record exists, because that is the order the stream has, and it has to reach the BORN
     * frame: no later frame carries the field. */
    it("takes 'backgrounded' from the spawning tool call, onto the frame that announces the child", () => {
        noteSubagentSpawn("call-1");
        expect(noteSubagentTask(turn(), started())).toMatchObject({ kind: "subagent", id: "call-1", background: true });
        expect(listSubagentSessions()).toMatchObject([{ id: "call-1", background: true }]);
    });

    // And a child the turn blocks on says nothing at all, rather than saying "background: false", the pill is
    // about the one case, and the absent field is what keeps it off every other card.
    it("leaves an unmarked child without the flag", () => {
        expect(noteSubagentTask(turn(), started())).not.toHaveProperty("background");
        expect(listSubagentSessions()[0]).not.toHaveProperty("background");
    });

    // The id is the SPAWNING TOOL CALL's, which is what makes the card and the record point at each other with no
    // correlation step, so a task with no tool_use id has no id to be listed under. The SDK's own note on
    // skip_transcript says as much: an ambient/housekeeping task is not a child anybody started.
    it("skips a task with no tool_use id, and an ambient one", () => {
        expect(noteSubagentTask(turn(), started({ tool_use_id: undefined }))).toBeUndefined();
        expect(noteSubagentTask(turn(), started({ skip_transcript: true }))).toBeUndefined();
        expect(listSubagentSessions()).toEqual([]);
    });

    /* THE BUG THIS SURFACE SHIPPED WITH. The SDK runs one task machine for all of its background work, so a Bash
     * command sent to the background arrives as a task_started with a tool_use id and a description, exactly like
     * a child does, and the area filled up with shell commands listed as agents, each opening on an empty
     * transcript because no per-child JSONL exists for something that was never a child. */
    it("files agent tasks only, not the shell/monitor/workflow work the same stream carries", () => {
        expect(
            noteSubagentTask(turn(), started({ subagent_type: undefined, task_type: "shell", description: "Run full web suite" })),
        ).toBeUndefined();
        expect(noteSubagentTask(turn(), started({ tool_use_id: "call-2", subagent_type: undefined, task_type: "monitor" }))).toBeUndefined();
        expect(noteSubagentTask(turn(), started({ tool_use_id: "call-3", subagent_type: undefined, task_type: "local_workflow" }))).toBeUndefined();
        // An unlabelled task is left off too: unknown task types are the SDK's to add, and guessing is what put
        // shell commands on this surface. A real child that arrives unlabelled is still adopted by the hooks.
        expect(noteSubagentTask(turn(), started({ tool_use_id: "call-4", subagent_type: undefined }))).toBeUndefined();
        expect(listSubagentSessions()).toEqual([]);
        // Either field is enough on its own: the Task tool sets subagent_type, the machine's discriminant is
        // task_type, and a child carrying only the latter is still a child.
        expect(noteSubagentTask(turn(), started({ tool_use_id: "call-5", subagent_type: undefined, task_type: "subagent" }))).toMatchObject({
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
        // Nothing changed the second time, so there is no frame: a client that re-renders per update should not
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

    // The turn's session id arrives on the stream's first frame, which can land AFTER a child is already open.
    // A record that copied it at birth kept the `undefined` it was born with, and a transcript read with no
    // session id reads nothing.
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

    // A stopped turn reports no terminal status for the children it was running, so the turn's end is what
    // settles them: a child left "running" forever is the lie this registry exists to remove.
    /* The quiet-worktree gate's question: an SDK child edits the parent's own checkout, a spawned child has a
     * worktree of its own, so only the former holds the parent's rebase off (agent.ts syncOnAnswer). */
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
        // Nothing left live in that conversation, so a second close says nothing.
        expect(closeSubagents("conv-1")).toEqual([]);
    });

    /* The window is SHORT (RETAIN_FINISHED_MS), because a turn spawns children faster than anything else on the
     * rail and a long one turns this list into an unpruned log. Pinned from both sides so the boundary is a
     * decision the test defends, not an accident of a number that happens to be larger than the wait. */
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

/* The third source: children the daemon itself runs (children/children.ts), reported by direct call. The suite
 * drives the same entry points the service calls; what it defends is that a spawned child is filed under its
 * PARENT, carries its provider on the wire, and outlives the parent's turn instead of being killed with it. */
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

    /* The exemption closeSubagents carries: a spawned child's turn genuinely outlives its parent's (the
     * backgrounded delegation's life), and the service settles it from the child's own ending. Killing it at
     * the parent's close would report a working agent as dead. */
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
        expect(listSubagentSessions()[0]).toMatchObject({ status: "failed", summary: "Got as far as the lexer.", error: "provider refused the model" });
    });

    it("hands the transcript reader the child's conversation key", () => {
        openSpawnedChild(turn(), { ...birth, harness: "native" });
        expect(subagentSource(birth.id)).toMatchObject({ kind: "spawned", conversationId: "conv-1", provider: "cursor", harness: "native" });
    });

    /* The follow-up `send`'s reopen: a settled record under the same id is replaced whole (fresh life, new
     * description), where a LIVE one stands — two turns cannot run on one conversation. */
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

/* The wait the tool parks on (subagent-wait.ts). The discipline under test is herdr's: subscribe before the
 * first look, so nothing lands in the gap; evaluate synchronously inside every transition, so a flicker still
 * counts; a timeout is an answer, not an error. */
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
        // Blocked and immediately un-blocked, with no await in between: a poll would have missed it.
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

    /* A WAIT THAT CANNOT BE SATISFIED ANSWERS NOW, rather than sleeping out its ten minutes. The candidate set
     * cannot grow while the wait runs: the only thing that opens a child of this conversation is the turn
     * parked inside this call, so a set with no live member is already the final answer. Both of these used to
     * hold the turn for the full timeout and then say nothing more than they can say here. */
    it("answers immediately when nothing live could ever satisfy the wait", async () => {
        // "any", with no children at all.
        expect(await waitForSubagent("conv-1", { until: ["blocked"], timeoutMs: 5_000 })).toMatchObject({ outcome: "unknown-target" });
        // A named child that has finished, waited on for a state only a live one can reach.
        spawn("bash-1");
        settleSpawnedChild("bash-1", { failed: false, report: "done" });
        expect(await waitForSubagent("conv-1", { target: "bash-1", until: ["blocked"], timeoutMs: 5_000 })).toMatchObject({
            outcome: "unknown-target",
            matched: { id: "bash-1", status: "completed" },
        });
    });

    // And the same check does not fire early: a live child is a wait worth having, even before it moves.
    it("still waits while the child is live", async () => {
        spawn("bash-1");
        const wait = waitForSubagent("conv-1", { target: "bash-1", until: ["finished"], timeoutMs: 5_000 });
        settleSpawnedChild("bash-1", { failed: false, report: "done" });
        expect(await wait).toMatchObject({ outcome: "finished" });
    });
});

/* THE ONE ENDING RULE (`ending` in subagents.ts). Three arrivals can each be the first to know a child is over
 * and they carry last words of very different worth, so: first arrival ends it, later ones may only make a
 * finished child failed, and the summary is kept by SOURCE rather than by who spoke last. */
describe("how a subagent ends", () => {
    it("keeps an SDK child's own last words over the task stream's later digest", async () => {
        const dir = await mkdtemp(join(tmpdir(), "subagents-ending-"));
        await writeFile(join(dir, "agent-xyz.meta.json"), JSON.stringify({ toolUseId: "call-1", agentType: "Explore" }));
        noteSubagentTask(turn(), started());
        // The stop hook hands over the child's own sign-off, which is what a person actually reads.
        await subagentHooks(turn()).SubagentStop?.[0]?.hooks[0]?.(
            {
                hook_event_name: "SubagentStop",
                agent_transcript_path: join(dir, "agent-xyz.jsonl"),
                agent_id: "xyz",
                last_assistant_message: "Found it in the reducer.",
            } as unknown as HookInput,
            "t1",
            { signal: new AbortController().signal },
        );
        // The SDK's exit notification lands afterwards with its own digest of the run: the child's words stand.
        noteSubagentTask(turn(), { subtype: "task_notification", tool_use_id: "call-1", status: "completed", summary: "ran 12 tools" });
        expect(listSubagentSessions()).toMatchObject([{ id: "call-1", status: "completed", summary: "Found it in the reducer." }]);
    });

    it("stamps the verification the moment it ends, whichever road it came down", () => {
        openSpawnedChild(turn(), { id: "sub-verify-1", description: "port the parser" });
        noteChildWork({ kind: "tool_call", id: "c1", name: "Edit", category: "edit", status: "completed", locations: [{ path: "src/parser.ts" }] }, "sub-verify-1");
        // Still working: a standing read mid-flight would call every child unproven before it reaches its tests.
        expect(listSubagentSessions()[0]?.verification).toBeUndefined();
        settleSpawnedChild("sub-verify-1", { failed: false, report: "Ported it." });
        expect(listSubagentSessions()[0]?.verification).toEqual({ state: "unproven", paths: ["src/parser.ts"] });
    });

    it("carries the verdict on the same frame as the report, for an SDK child too", () => {
        noteSubagentTask(turn(), started({ tool_use_id: "call-v" }));
        noteChildWork({ kind: "tool_call", id: "c1", name: "Write", category: "edit", status: "completed", locations: [{ path: "src/a.ts" }] }, "call-v");
        noteChildWork({ kind: "tool_call", id: "c2", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" }, "call-v");
        noteChildWork({ kind: "tool_call_update", id: "c2", status: "completed", content: [{ type: "text", text: "--- [exit 0, 2s]" }] }, undefined);
        const frame = update(noteSubagentTask(turn(), { subtype: "task_notification", tool_use_id: "call-v", status: "completed", summary: "done" }));
        expect(frame.verification).toEqual({ state: "verified", paths: ["src/a.ts"], check: "pnpm test" });
    });

    /* The stamp onto the report itself, which is the whole point: the parent reads the Task result, and the
     * fact about whether anything checked it arrives in the same breath. */
    it("appends the warning to a Task result the parent is about to read", async () => {
        noteSubagentTask(turn(), started({ tool_use_id: "call-w" }));
        noteChildWork({ kind: "tool_call", id: "c1", name: "Edit", category: "edit", status: "completed", locations: [{ path: "src/a.ts" }] }, "call-w");
        const output = await subagentHooks(turn()).PostToolUse?.[0]?.hooks[0]?.(
            { hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: "call-w", tool_input: {}, tool_response: "Done." } as unknown as HookInput,
            "t1",
            { signal: new AbortController().signal },
        );
        expect((output as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext).toContain("UNPROVEN");
    });

    // And a child with nothing to warn about spends none of the parent's context saying so.
    it("says nothing about a child that edited no code", async () => {
        noteSubagentTask(turn(), started({ tool_use_id: "call-q" }));
        noteChildWork({ kind: "tool_call", id: "c1", name: "Grep", category: "search", status: "completed", target: "needle" }, "call-q");
        const output = await subagentHooks(turn()).PostToolUse?.[0]?.hooks[0]?.(
            { hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: "call-q", tool_input: {}, tool_response: "Found it." } as unknown as HookInput,
            "t1",
            { signal: new AbortController().signal },
        );
        expect(output).toEqual({ continue: true });
    });

    it("does not re-end a finished child, but does let a late failure through", () => {
        openSpawnedChild(turn(), { id: "sub-late-1", description: "go" });
        settleSpawnedChild("sub-late-1", { failed: false, report: "All done." });
        expect(listSubagentSessions()).toMatchObject([{ id: "sub-late-1", status: "completed" }]);
        // A second "completed" changes nothing; a failure that follows the sign-off still gets to say so,
        // because that is the half of the story the sign-off did not have.
        settleSpawnedChild("sub-late-1", { failed: false, report: "" });
        expect(listSubagentSessions()).toMatchObject([{ id: "sub-late-1", status: "completed" }]);
        settleSpawnedChild("sub-late-1", { failed: true, report: "", error: "exit 1" });
        expect(listSubagentSessions()).toMatchObject([{ id: "sub-late-1", status: "failed", summary: "All done.", error: "exit 1" }]);
    });
});
