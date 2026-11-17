import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentStopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { listSubagentSessions, noteSubagentTask, resetSubagents, subagentHooks, type SubagentTaskMessage, type SubagentTurn, waitForSubagent } from "../../subagents.js";
import { waitForSubagents } from "../subagent-waits.js";
import { waitTargetOf } from "../wait-targets.js";

/* 2026-11-17, the shinobi-society audit: an Agent-tool helper its parent resumed with SendMessage is announced by another
   task_started under the same task id (its agentId), with the SendMessage call's id as its tool_use_id, or the original
   Agent call's when nothing called it back. `wait` on it answered at once with the first run's ending, and `wait any`
   saw nothing running or a record the resumed run's report never reached. */

const actors = memoryFleet().conversations;
const AGENT_ID = "ab43e24798df62187";
let dir = "";
let turn: SubagentTurn;

beforeEach(async () => {
    resetSubagents(actors);
    dir = await mkdtemp(join(tmpdir(), "resumed-helper-"));
    turn = { conversationId: "conv-r", conversations: actors, subagentsDir: dir };
    // Written once at the helper's first start, naming the Agent call that spawned it; a resume never rewrites it.
    await writeFile(join(dir, `agent-${AGENT_ID}.meta.json`), JSON.stringify({ toolUseId: "toolu_agent", agentType: "general-purpose" }));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const started = (toolUseId: string): SubagentTaskMessage => ({
    subtype: "task_started",
    task_id: AGENT_ID,
    tool_use_id: toolUseId,
    description: "Compress idle Claude session files",
    subagent_type: "general-purpose",
    task_type: "local_agent",
});

// The CLI's SubagentStop for a run of the helper: its transcript and meta file are the same for every run.
const stopped = async (lastAssistantMessage: string): Promise<void> => {
    const input: SubagentStopHookInput = {
        hook_event_name: "SubagentStop",
        session_id: "session",
        transcript_path: join(dir, "session.jsonl"),
        cwd: dir,
        stop_hook_active: false,
        agent_id: AGENT_ID,
        agent_type: "general-purpose",
        agent_transcript_path: join(dir, `agent-${AGENT_ID}.jsonl`),
        last_assistant_message: lastAssistantMessage,
    };
    await subagentHooks(turn).SubagentStop?.[0]?.hooks[0]?.(input, "hook", { signal: new AbortController().signal });
};

const completed = (): void => {
    noteSubagentTask(turn, { subtype: "task_updated", task_id: AGENT_ID, patch: { status: "completed" } });
};

// The first run, start to end, its ending handed to the parent by a wait on "any".
const firstRun = async (): Promise<void> => {
    noteSubagentTask(turn, started("toolu_agent"));
    await stopped("first report");
    completed();
    const handed = await waitForSubagent(actors, "conv-r", { until: ["blocked", "finished"], timeoutMs: 1_000 });
    expect(handed.matched).toMatchObject({ id: "toolu_agent", status: "completed", summary: "first report" });
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("an Agent-tool helper resumed with SendMessage", () => {
    it("reads as running again under every name it has, and a wait on its agentId hands over the resumed run's report", async () => {
        await firstRun();
        expect(noteSubagentTask(turn, started("toolu_send"))).toEqual({ kind: "subagent_update", id: "toolu_agent", status: "running" });
        // One helper, one row: no stranger under the SendMessage call, and nothing of the first run's ending left on it.
        const rows = listSubagentSessions(actors);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: "toolu_agent", status: "running" });
        expect(rows[0]).not.toHaveProperty("summary");
        expect(rows[0]).not.toHaveProperty("endedAt");
        for (const name of [AGENT_ID, "toolu_agent", "toolu_send"]) {
            expect(await waitTargetOf(actors, "conv-r", name, undefined, 0)).toBe("toolu_agent");
        }
        let answered = false;
        const named = waitForSubagent(actors, "conv-r", { target: "toolu_agent", until: ["blocked", "finished"], timeoutMs: 2_000 }).finally(() => {
            answered = true;
        });
        await tick();
        expect(answered).toBe(false);
        // The resumed run's own messages name the SendMessage call; they move the same record.
        noteSubagentTask(turn, { subtype: "task_progress", task_id: AGENT_ID, tool_use_id: "toolu_send", usage: { tool_uses: 218 }, last_tool_name: "Bash" });
        await stopped("second report");
        completed();
        const result = await named;
        expect(result.outcome).toBe("finished");
        expect(result.matched).toMatchObject({ id: "toolu_agent", status: "completed", summary: "second report", toolUses: 218 });
    });

    it("is a running child to `wait any` and `all` again when the CLI resumes it under its first call's id", async () => {
        await firstRun();
        expect(noteSubagentTask(turn, started("toolu_agent"))).toEqual({ kind: "subagent_update", id: "toolu_agent", status: "running" });
        const any = waitForSubagent(actors, "conv-r", { until: ["blocked", "finished"], timeoutMs: 2_000 });
        const all = waitForSubagents(actors, "conv-r", { timeoutMs: 2_000 });
        await tick();
        await stopped("second report");
        completed();
        expect(await any).toMatchObject({ outcome: "finished", matched: { id: "toolu_agent", summary: "second report" } });
        const together = await all;
        expect(together.outcome).toBe("finished");
        expect(together.agents).toMatchObject([{ id: "toolu_agent", status: "completed", summary: "second report" }]);
    });

    it("leaves a run already under way alone when its start is heard twice", () => {
        noteSubagentTask(turn, started("toolu_agent"));
        expect(noteSubagentTask(turn, started("toolu_agent"))).toBeUndefined();
        expect(listSubagentSessions(actors)).toMatchObject([{ id: "toolu_agent", status: "running" }]);
    });
});
