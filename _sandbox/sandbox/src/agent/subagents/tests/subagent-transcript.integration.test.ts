import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import { memoryFleet } from "../../../testing.js";
import { startTurnRun } from "../../run/turn/turn-runs.js";
import { createDomainEvents } from "../../../seams/domain-events.js";
import type { TurnStarter } from "../../../seams/turn-starter.js";
import { readSubagentTranscript, type SubagentTranscriptDeps } from "../subagent-transcript.js";
import { noteSubagentTask, openSpawnedChild, resetSubagents, type SubagentTaskMessage, type SubagentTurn } from "../subagents.js";

// One in-process subagent read as a transcript of its own: the runtime's own record of it where it keeps one, else the
// calls its delegation's card holds in the parent's live run or settled record.

const actors = memoryFleet().conversations;

const started = (toolUseId: string): SubagentTaskMessage =>
    ({
        subtype: "task_started",
        task_id: `task-${toolUseId}`,
        tool_use_id: toolUseId,
        description: "Find every caller",
        subagent_type: "Explore",
    }) as SubagentTaskMessage;

const turn = (subagentsDir?: string, conversationId = "conv-1"): SubagentTurn => ({ conversationId, conversations: actors, subagentsDir });

const grep: TranscriptTool = { id: "grep-1", name: "Grep", category: "search", status: "completed", target: "createCheckoutSession" };

// The delegation's card as the parent's record keeps it: the call that started the subagent, its calls under it.
const delegation = (over: Partial<TranscriptTool> = {}): TranscriptTool => ({
    id: "call-1",
    name: "Agent",
    category: "other",
    status: "in_progress",
    target: "Explore: Find every caller",
    children: [grep],
    ...over,
});

// Deps whose two stores answer as told, recording what they were asked.
const deps = (own: TranscriptRow[] = [], recorded?: TranscriptTool) => {
    const asked: { sdk: [string, string][]; record: [string, string][] } = { sdk: [], record: [] };
    const value: SubagentTranscriptDeps = {
        conversations: actors,
        sdkMessages: async (sessionId, agentId) => {
            asked.sdk.push([sessionId, agentId]);
            return own;
        },
        toolCard: async (agent, toolId) => {
            asked.record.push([agent.id, toolId]);
            return recorded;
        },
    };
    return { value, asked };
};

// A Claude session's subagents directory, `<session>/subagents`, with one child's meta file in it.
const claudeDir = async (toolUseId: string, agentId: string): Promise<string> => {
    const dir = join(await mkdtemp(join(tmpdir(), "subagent-transcript-")), "ses-parent", "subagents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId, agentType: "Explore" }));
    return dir;
};

beforeEach(() => resetSubagents(actors));

describe("readSubagentTranscript", () => {
    it("reads a Claude subagent from the runtime's own record, pairing it on the spot", async () => {
        noteSubagentTask(turn(await claudeDir("call-1", "a1b2")), started("call-1"));
        const own: TranscriptRow[] = [
            { role: "user", text: "Find every caller of createCheckoutSession" },
            { role: "assistant", text: "Two callers.", tools: [grep] },
        ];
        const { value, asked } = deps(own);
        expect(await readSubagentTranscript(value, "conv-1", "call-1")).toEqual(own);
        // The session is the directory the subagents directory sits in.
        expect(asked.sdk).toEqual([["ses-parent", "a1b2"]]);
        expect(asked.record).toEqual([]);
    });

    it("falls back to the card's calls in the parent's record, under the ask, when the runtime kept nothing", async () => {
        noteSubagentTask(turn(await claudeDir("call-1", "a1b2")), started("call-1"));
        const { value, asked } = deps([], delegation());
        expect(await readSubagentTranscript(value, "conv-1", "call-1")).toEqual([
            { role: "user", text: "Find every caller" },
            { role: "assistant", text: "", tools: [grep] },
        ]);
        expect(asked.record).toEqual([["conv-1", "call-1"]]);
    });

    // Its own conversation: a run outlives its test (held for a while after it ends), and would answer for the others.
    it("reads another runtime's subagent off the parent's live run before its record", async () => {
        noteSubagentTask(turn(undefined, "conv-live"), started("call-1"));
        let release = (): void => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const pump: TurnStarter["stream"] = async function* stream() {
            yield { kind: "tool_call", id: "call-1", name: "Agent", category: "other", status: "in_progress" };
            yield { kind: "tool_call", id: "grep-1", name: "Grep", category: "search", status: "completed", parentToolUseId: "call-1" };
            await held;
        };
        startTurnRun({ conversations: actors, events: createDomainEvents(() => {}) }, pump, { conversationId: "conv-live", prompt: "fan out" });
        try {
            // The pump's frames land on the run on their own clock.
            await new Promise((resolve) => setTimeout(resolve, 20));
            const { value, asked } = deps();
            const rows = await readSubagentTranscript(value, "conv-live", "call-1");
            expect(rows[0]).toEqual({ role: "user", text: "Find every caller" });
            expect(rows[1]?.tools?.map((tool) => tool.id)).toEqual(["grep-1"]);
            expect(asked.sdk).toEqual([]);
            expect(asked.record).toEqual([]);
        } finally {
            release();
        }
    });

    it("ends on the report the parent read, and asks what the card says once the roster has let the subagent go", async () => {
        const settled = delegation({
            id: "call-gone",
            status: "completed",
            content: [{ type: "text", text: "Two callers: checkout.ts and cart.ts." }],
        });
        const { value } = deps([], settled);
        expect(await readSubagentTranscript(value, "conv-1", "call-gone")).toEqual([
            { role: "user", text: "Explore: Find every caller" },
            { role: "assistant", text: "Two callers: checkout.ts and cart.ts.", tools: [grep] },
        ]);
    });

    it("is empty when nothing was recorded yet", async () => {
        noteSubagentTask(turn(), started("call-1"));
        expect(await readSubagentTranscript(deps().value, "conv-1", "call-1")).toEqual([]);
    });

    it("refuses a subagent another conversation started", async () => {
        noteSubagentTask(turn(), started("call-1"));
        await expect(readSubagentTranscript(deps().value, "conv-2", "call-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("sends a spawned subagent to its own conversation's transcript", async () => {
        openSpawnedChild(turn(), { id: "child-1", description: "Write the webhook handler", provider: "codex" });
        await expect(readSubagentTranscript(deps().value, "conv-1", "child-1")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
});
