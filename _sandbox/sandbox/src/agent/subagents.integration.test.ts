import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    closeSubagents,
    listSubagentSessions,
    noteDelegation,
    noteDelegationSignal,
    noteSubagentSpawn,
    noteSubagentTask,
    resetSubagents,
    settleDelegation,
    subagentAgentId,
    subagentCountsOf,
    subagentHooks,
    subagentSource,
    waitForSubagent,
    type SubagentTaskMessage,
    type SubagentTurn,
} from "./subagents.js";
import { delegationIdOfTitle } from "../grok/opencode.js";

const turn = (): SubagentTurn => ({ conversationId: "conv-1", cwd: WORKSPACE_ROOT, sessionId: "sess-1", subagentsDir: undefined });

// A `task_started` as the SDK delivers it. An override spelled out as `undefined` states that the SDK sent the
// task WITHOUT that field — the case two of these suites are about — which is why the override map admits
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
     * task_updated patch that does not come — a real backgrounded child was watched through birth, work, report
     * and death without it arriving once — so the spawning tool call is where it comes from instead. The mark is
     * laid before the record exists, because that is the order the stream has, and it has to reach the BORN
     * frame: no later frame carries the field. */
    it("takes 'backgrounded' from the spawning tool call, onto the frame that announces the child", () => {
        noteSubagentSpawn("call-1");
        expect(noteSubagentTask(turn(), started())).toMatchObject({ kind: "subagent", id: "call-1", background: true });
        expect(listSubagentSessions()).toMatchObject([{ id: "call-1", background: true }]);
    });

    // And a child the turn blocks on says nothing at all, rather than saying "background: false" — the pill is
    // about the one case, and the absent field is what keeps it off every other card.
    it("leaves an unmarked child without the flag", () => {
        expect(noteSubagentTask(turn(), started())).not.toHaveProperty("background");
        expect(listSubagentSessions()[0]).not.toHaveProperty("background");
    });

    // The id is the SPAWNING TOOL CALL's, which is what makes the card and the record point at each other with no
    // correlation step — so a task with no tool_use id has no id to be listed under. The SDK's own note on
    // skip_transcript says as much: an ambient/housekeeping task is not a child anybody started.
    it("skips a task with no tool_use id, and an ambient one", () => {
        expect(noteSubagentTask(turn(), started({ tool_use_id: undefined }))).toBeUndefined();
        expect(noteSubagentTask(turn(), started({ skip_transcript: true }))).toBeUndefined();
        expect(listSubagentSessions()).toEqual([]);
    });

    /* THE BUG THIS SURFACE SHIPPED WITH. The SDK runs one task machine for all of its background work, so a Bash
     * command sent to the background arrives as a task_started with a tool_use id and a description, exactly like
     * a child does — and the area filled up with shell commands listed as agents, each opening on an empty
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
        // Either field is enough on its own — the Task tool sets subagent_type, the machine's discriminant is
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

/* THE PAIRING BETWEEN A CHILD AND THE TOOL CALL THAT SPAWNED IT — the fact the whole transcript door hangs on,
 * and the one this surface shipped without. It was read in the SubagentStart hook, which fires BEFORE the SDK
 * writes the meta file it was being read from, so it never once succeeded; the SubagentStop hook was the only
 * one that ever landed a pairing, and that hook never comes for a backgrounded child whose parent turn ends
 * first — which is the Agent tool's DEFAULT. Every one of those children listed its tokens and its tool count
 * and then opened on "No transcript was recorded", with its JSONL complete on disk. */
describe("pairing a child to its transcript", () => {
    const meta = (dir: string, agentId: string, body: Record<string, unknown>): Promise<void> =>
        writeFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(body));

    it("resolves the agent id from the session's meta files, and takes what else they say", async () => {
        const dir = await mkdtemp(join(tmpdir(), "subagents-"));
        const handle: SubagentTurn = { conversationId: "conv-1", cwd: WORKSPACE_ROOT, sessionId: "sess-1", subagentsDir: undefined };

        // The start hook's one job: name the directory this session files its children in. It carries the
        // PARENT's transcript path, and the children live in a directory named after it.
        const startHook = subagentHooks(handle).SubagentStart?.[0]?.hooks[0];
        await startHook?.(
            { hook_event_name: "SubagentStart", transcript_path: join(dir, "sess-1.jsonl"), agent_id: "a1" } as unknown as HookInput,
            "t1",
            {
                signal: new AbortController().signal,
            },
        );
        expect(handle.subagentsDir).toBe(join(dir, "sess-1", "subagents"));

        // The real directory, as the SDK fills it: a sibling child of the same turn, and ours.
        handle.subagentsDir = dir;
        noteSubagentTask(handle, started());
        await meta(dir, "sibling", { toolUseId: "call-9", agentType: "Explore" });
        await meta(dir, "a1b2c3", { toolUseId: "call-1", agentType: "Explore", model: "opus", spawnDepth: 1 });

        expect(await subagentAgentId("call-1")).toBe("a1b2c3");
        // And the rest of the meta rides along — the model and the spawn depth reach the card the same way.
        expect(listSubagentSessions()).toMatchObject([{ id: "call-1", model: "opus", spawnDepth: 1 }]);
    });

    // Nothing to scan (no child of this turn ever started, so no hook ever named a directory) and no such
    // child — both are "no transcript", which is what the surface already draws.
    it("answers nothing for a child it cannot place", async () => {
        noteSubagentTask(turn(), started());
        expect(await subagentAgentId("call-1")).toBeUndefined();
        expect(await subagentAgentId("nobody")).toBeUndefined();
    });
});

describe("delegations", () => {
    it("files a codex exec as an agent, with the prompt as its description", () => {
        const frame = noteDelegation(turn(), {
            id: "bash-1",
            command: "codex exec --sandbox danger-full-access --cd /work 'Port the auth module to the new client'",
            terminal: "agent-abc12345",
            background: false,
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
        noteDelegation(turn(), {
            id: "bash-2",
            command: "XDG_DATA_HOME=/agent-auth opencode run --session ses_7f3 --model xai/grok-4 'keep going'",
            background: false,
        });
        expect(subagentSource("bash-2")).toMatchObject({ kind: "grok", thread: "ses_7f3" });
    });

    // A resumed thread is the same agent carrying on, so it updates the record it names rather than opening a
    // second one — and a command that merely MENTIONS a delegation verb is not an agent at all.
    it("takes the thread id off a resume, and ignores a command that only mentions codex", () => {
        noteDelegation(turn(), {
            id: "bash-3",
            command: "codex exec --sandbox danger-full-access resume 019fb7fd-349b-7571 'and now the tests'",
            background: false,
        });
        expect(subagentSource("bash-3")).toMatchObject({ kind: "codex", thread: "019fb7fd-349b-7571" });
        expect(noteDelegation(turn(), { id: "bash-4", command: "grep -rn 'codex exec' docs/", background: false })).toBeUndefined();
        expect(noteDelegation(turn(), { id: "bash-5", command: "echo how to codex", background: false })).toBeUndefined();
        expect(listSubagentSessions().map((session) => session.id)).toEqual(["bash-3"]);
    });

    it("settles on the command's result, taking its tail as the report", () => {
        noteDelegation(turn(), { id: "bash-6", command: "codex exec 'audit the gate'", background: false });
        expect(update(settleDelegation("bash-6", { failed: false, output: "  looked at 4 files\nthe gate is fine  " }))).toMatchObject({
            status: "completed",
            summary: "looked at 4 files\nthe gate is fine",
        });
        expect(settleDelegation("never-started", { failed: false, output: "x" })).toBeUndefined();
    });

    /* A BACKGROUNDED DELEGATION'S RESULT ANNOUNCES ITS START, NOT ITS END. Settling on it is a measured lie: a
     * `codex exec` sent to the background was marked completed 0.2 seconds in, and the roster said "done" for
     * the 103 seconds the delegate went on working. So the start message settles nothing and the delegate keeps
     * counting as one of the children the session is waiting on — the background task's own notification, which
     * lands when the command exits, is what ends it and carries the report. */
    it("leaves a backgrounded delegation running until its background task reports", () => {
        expect(noteDelegation(turn(), { id: "bash-8", command: "codex exec 'audit the gate'", background: true })).toMatchObject({
            kind: "subagent",
            background: true,
        });
        expect(settleDelegation("bash-8", { failed: false, output: "Command running in background with ID: b1" })).toBeUndefined();
        expect(subagentCountsOf("conv-1")).toEqual({ running: 1, total: 1 });
        expect(
            update(
                noteSubagentTask(turn(), {
                    subtype: "task_notification",
                    tool_use_id: "bash-8",
                    status: "completed",
                    summary: "the gate is fine",
                }),
            ),
        ).toMatchObject({ status: "completed", summary: "the gate is fine" });
        expect(subagentCountsOf("conv-1")).toEqual({ running: 0, total: 1 });
    });

    it("reports a failed delegation's tail as the error too", () => {
        noteDelegation(turn(), { id: "bash-7", command: "codex exec 'audit the gate'", background: false });
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
        noteDelegation(turn(), { id: "bash-1", command: "codex exec 'go'", background: false });
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

/* What the delegate ITSELF reports — the codex hook spool and the warm OpenCode server's events — folded onto
 * the records the Bash stream opened. The suite drives the same entry points the transports call
 * (delegation-signals.ts, grok/opencode.ts): nothing here fakes a roster. */
describe("delegation signals", () => {
    const spawn = (id = "bash-1", background = false): void => {
        noteDelegation(turn(), {
            id,
            command: "codex exec --sandbox danger-full-access --dangerously-bypass-hook-trust 'do the thing'",
            background,
        });
    };

    it("binds the session id a start signal carries, so the transcript reader has its thread", () => {
        spawn();
        noteDelegationSignal({ delegationId: "bash-1", event: "session", thread: "019f-abc" });
        expect(subagentSource("bash-1")).toMatchObject({ thread: "019f-abc" });
    });

    it("moves a live record to blocked and back to running", () => {
        spawn();
        noteDelegationSignal({ delegationId: "bash-1", event: "blocked" });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "blocked" }]);
        noteDelegationSignal({ delegationId: "bash-1", event: "working" });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "running" }]);
    });

    it("a report completes a BACKGROUNDED record with the delegate's own last words, and the SDK's later digest does not overwrite them", () => {
        spawn("bash-1", true);
        noteDelegationSignal({ delegationId: "bash-1", event: "report", summary: "Ported the module; tests pass." });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "completed", summary: "Ported the module; tests pass." }]);
        // The background task's exit notification lands minutes later with a stdout digest — the report stands.
        noteSubagentTask(turn(), { subtype: "task_notification", tool_use_id: "bash-1", status: "completed", summary: "stdout digest" });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", summary: "Ported the module; tests pass." }]);
    });

    it("a report leaves a FOREGROUND record running for its own tool_result, which keeps the reported summary", () => {
        spawn();
        noteDelegationSignal({ delegationId: "bash-1", event: "report", summary: "All done." });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "running", summary: "All done." }]);
        settleDelegation("bash-1", { failed: false, output: "…raw stdout tail…" });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "completed", summary: "All done." }]);
    });

    it("signals never reopen a settled record, and unknown ids fall on the floor", () => {
        spawn();
        settleDelegation("bash-1", { failed: false, output: "done" });
        noteDelegationSignal({ delegationId: "bash-1", event: "working" });
        noteDelegationSignal({ delegationId: "bash-1", event: "blocked" });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "completed" }]);
        expect(() => noteDelegationSignal({ delegationId: "nobody", event: "blocked" })).not.toThrow();
    });

    it("shows what the delegate is doing — a working signal's tool is the record's live line", () => {
        spawn();
        noteDelegationSignal({ delegationId: "bash-1", event: "working", tool: "Bash" });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "running", lastTool: "Bash" }]);
    });

    it("a blocked signal carries its reason, and the delegate's later report replaces it", () => {
        spawn();
        noteDelegationSignal({ delegationId: "bash-1", event: "blocked", summary: "waiting on permission for Bash: rm -rf build" });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "blocked", summary: "waiting on permission for Bash: rm -rf build" }]);
        noteDelegationSignal({ delegationId: "bash-1", event: "report", summary: "Build directory rebuilt." });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", summary: "Build directory rebuilt." }]);
    });

    it("a failed exit keeps the delegate's reported words as the summary and takes the tail as the error", () => {
        spawn();
        noteDelegationSignal({ delegationId: "bash-1", event: "report", summary: "Looks good." });
        settleDelegation("bash-1", { failed: true, output: "ERROR: session expired" });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "failed", summary: "Looks good.", error: "ERROR: session expired" }]);
    });

    /* THE OPENCODE SESSION IS PAIRED BY NAME, NOT BY TIMING. This replaced a guess — the youngest grok
     * delegation that did not have a session yet — which two concurrent runs could cross. The title the
     * PreToolUse rewrite stamps (agent-terminals.ts) carries the spawning call's own id, so it cannot. */
    it("pairs an opencode session with the delegation its title names, even with two running at once", () => {
        noteDelegation(turn(), { id: "grok-1", command: "opencode run --attach http://127.0.0.1:4096 'first'", background: true });
        noteDelegation(turn(), { id: "grok-2", command: "opencode run --attach http://127.0.0.1:4096 'second'", background: true });
        // Both sessions land, youngest-first — the order that used to hand grok-1's session to grok-2.
        noteDelegationSignal({ delegationId: delegationIdOfTitle("intentic-delegation-grok-1")!, thread: "ses_one", event: "session" });
        noteDelegationSignal({ delegationId: delegationIdOfTitle("intentic-delegation-grok-2")!, thread: "ses_two", event: "session" });
        expect(subagentSource("grok-1")).toMatchObject({ thread: "ses_one" });
        expect(subagentSource("grok-2")).toMatchObject({ thread: "ses_two" });
        // And later events reach each record through the thread it bound.
        noteDelegationSignal({ thread: "ses_two", event: "blocked" });
        expect(
            listSubagentSessions()
                .filter((session) => session.status === "blocked")
                .map((session) => session.id),
        ).toEqual(["grok-2"]);
    });

    // A session belonging to nothing this daemon started — the Grok adapter's own turns — carries no id, and
    // an unnamed session is left alone rather than pinned on whichever delegation happens to be youngest.
    it("reads no delegation out of a title that does not carry one", () => {
        expect(delegationIdOfTitle("some other session")).toBeUndefined();
        expect(delegationIdOfTitle("intentic-delegation")).toBeUndefined();
        expect(delegationIdOfTitle("intentic-delegation-toolu_01ABC def")).toBe("toolu_01ABC");
    });
});

/* The wait the tool parks on (subagent-wait.ts). The discipline under test is herdr's: subscribe before the
 * first look, so nothing lands in the gap; evaluate synchronously inside every transition, so a flicker still
 * counts; a timeout is an answer, not an error. */
describe("waitForSubagent", () => {
    const spawn = (id: string, background = true): void => {
        noteDelegation(turn(), {
            id,
            command: "codex exec --sandbox danger-full-access --dangerously-bypass-hook-trust 'do the thing'",
            background,
        });
    };

    it("resolves immediately when the target already satisfies the wait", async () => {
        spawn("bash-1");
        noteDelegationSignal({ delegationId: "bash-1", event: "report", summary: "done" });
        const result = await waitForSubagent("conv-1", { target: "bash-1", until: ["finished"], timeoutMs: 5_000 });
        expect(result).toMatchObject({ outcome: "finished", matched: { id: "bash-1", status: "completed" } });
    });

    it("wakes when the child blocks", async () => {
        spawn("bash-1");
        const wait = waitForSubagent("conv-1", { target: "bash-1", until: ["blocked", "finished"], timeoutMs: 5_000 });
        noteDelegationSignal({ delegationId: "bash-1", event: "blocked" });
        expect(await wait).toMatchObject({ outcome: "blocked", matched: { id: "bash-1", status: "blocked" } });
    });

    it("a blocked flicker still wakes the waiter — the listener runs inside the transition, not after it", async () => {
        spawn("bash-1");
        const wait = waitForSubagent("conv-1", { target: "bash-1", until: ["blocked"], timeoutMs: 5_000 });
        // Blocked and immediately un-blocked, with no await in between: a poll would have missed it.
        noteDelegationSignal({ delegationId: "bash-1", event: "blocked" });
        noteDelegationSignal({ delegationId: "bash-1", event: "working" });
        expect(await wait).toMatchObject({ outcome: "blocked" });
    });

    it("with no target, the first of the conversation's children to move settles the wait — other conversations' don't", async () => {
        spawn("bash-1");
        noteDelegation(
            { conversationId: "conv-2", cwd: WORKSPACE_ROOT, sessionId: "sess-2", subagentsDir: undefined },
            { id: "bash-other", command: "codex exec 'elsewhere'", background: true },
        );
        const wait = waitForSubagent("conv-1", { until: ["blocked"], timeoutMs: 5_000 });
        noteDelegationSignal({ delegationId: "bash-other", event: "blocked" });
        noteDelegationSignal({ delegationId: "bash-1", event: "blocked" });
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
     * cannot grow while the wait runs — the only thing that opens a child of this conversation is the turn
     * parked inside this call — so a set with no live member is already the final answer. Both of these used to
     * hold the turn for the full timeout and then say nothing more than they can say here. */
    it("answers immediately when nothing live could ever satisfy the wait", async () => {
        // "any", with no children at all.
        expect(await waitForSubagent("conv-1", { until: ["blocked"], timeoutMs: 5_000 })).toMatchObject({ outcome: "unknown-target" });
        // A named child that has finished, waited on for a state only a live one can reach.
        spawn("bash-1");
        noteDelegationSignal({ delegationId: "bash-1", event: "report", summary: "done" });
        expect(await waitForSubagent("conv-1", { target: "bash-1", until: ["blocked"], timeoutMs: 5_000 })).toMatchObject({
            outcome: "unknown-target",
            matched: { id: "bash-1", status: "completed" },
        });
    });

    // And the same check does not fire early: a live child is a wait worth having, even before it moves.
    it("still waits while the child is live", async () => {
        spawn("bash-1");
        const wait = waitForSubagent("conv-1", { target: "bash-1", until: ["finished"], timeoutMs: 5_000 });
        noteDelegationSignal({ delegationId: "bash-1", event: "report", summary: "done" });
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
        // The SDK's exit notification lands afterwards with its own digest of the run — the child's words stand.
        noteSubagentTask(turn(), { subtype: "task_notification", tool_use_id: "call-1", status: "completed", summary: "ran 12 tools" });
        expect(listSubagentSessions()).toMatchObject([{ id: "call-1", status: "completed", summary: "Found it in the reducer." }]);
    });

    it("does not re-end a finished child, but does let a late failure through", () => {
        noteDelegation(turn(), { id: "bash-1", command: "codex exec 'go'", background: true });
        noteDelegationSignal({ delegationId: "bash-1", event: "report", summary: "All done." });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "completed" }]);
        // A second "completed" changes nothing; the exit code that follows the sign-off still gets to say it
        // failed, because that is the half of the story the sign-off did not have.
        noteSubagentTask(turn(), { subtype: "task_notification", tool_use_id: "bash-1", status: "completed" });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "completed" }]);
        noteSubagentTask(turn(), { subtype: "task_notification", tool_use_id: "bash-1", status: "failed" });
        expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "failed", summary: "All done." }]);
    });
});
