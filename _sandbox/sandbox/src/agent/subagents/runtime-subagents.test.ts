import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { withRuntimeSubagents } from "./runtime-subagents.js";
import { listSubagentSessions, resetSubagents, type SubagentTurn } from "./subagents.js";
import { memoryFleet } from "../../testing.js";

// Pins that a subagent some runtime other than the Claude loop reports in its own frames lands on the same roster the
// Claude loop's do: listed, moving, ended with a verdict on its work, and closed with the turn when the runtime never
// ended it.

const actors = memoryFleet().conversations;

const turn = (): SubagentTurn => ({ conversationId: "conv-r", conversations: actors, cwd: WORKSPACE_ROOT, sessionId: undefined, subagentsDir: undefined });

// A runtime's frames, as its adapter yields them.
async function* reported(frames: readonly AgentEvent[]): AsyncGenerator<AgentEvent> {
    yield* frames;
}

const through = async (frames: readonly AgentEvent[]): Promise<AgentEvent[]> => {
    const out: AgentEvent[] = [];
    for await (const frame of withRuntimeSubagents(reported(frames), turn())) {
        out.push(frame);
    }
    return out;
};

beforeEach(() => resetSubagents(actors));

describe("a runtime's own subagents", () => {
    it("files the subagent a delegating call reports, and ends it with a verdict on the work it did", async () => {
        const out = await through([
            { kind: "tool_call", id: "task-1", name: "Task", category: "other", status: "in_progress" },
            { kind: "subagent", id: "task-1", subagentKind: "subagent", agentType: "explore", description: "Map the reads" },
            { kind: "tool_call", id: "e1", name: "Edit", category: "edit", status: "completed", locations: [{ path: "src/a.ts" }], parentToolUseId: "task-1" },
            { kind: "subagent_update", id: "task-1", toolUses: 1, lastTool: "Edit" },
            { kind: "subagent_update", id: "task-1", status: "completed", summary: "Ported." },
        ]);
        expect(out.filter((frame) => frame.kind === "subagent" || frame.kind === "subagent_update")).toEqual([
            { kind: "subagent", id: "task-1", subagentKind: "subagent", agentType: "explore", description: "Map the reads" },
            { kind: "subagent_update", id: "task-1", toolUses: 1, lastTool: "Edit" },
            { kind: "subagent_update", id: "task-1", status: "completed", summary: "Ported.", verification: { state: "unproven", paths: ["src/a.ts"] } },
        ]);
        expect(listSubagentSessions(actors)).toMatchObject([
            { id: "task-1", kind: "subagent", conversationId: "conv-r", status: "completed", summary: "Ported.", verification: { state: "unproven" } },
        ]);
    });

    it("passes the runtime's other frames on as they came, and drops a move that moves nothing", async () => {
        const out = await through([
            { kind: "delta", text: "delegating" },
            { kind: "subagent", id: "task-2", subagentKind: "subagent" },
            { kind: "subagent_update", id: "task-2", status: "running" },
            { kind: "subagent_update", id: "unknown", status: "completed" },
            { kind: "subagent_update", id: "task-2", status: "completed" },
        ]);
        expect(out.map((frame) => frame.kind)).toEqual(["delta", "subagent", "subagent_update"]);
    });

    // The Claude loop kills an in-process subagent its turn left running; a runtime's own go the same way.
    it("closes a subagent the runtime never ended as its turn ends, and says so", async () => {
        const out = await through([{ kind: "subagent", id: "task-3", subagentKind: "subagent", description: "Still going" }]);
        expect(out.at(-1)).toEqual({ kind: "subagent_update", id: "task-3", status: "killed" });
        expect(listSubagentSessions(actors)[0]?.status).toBe("killed");
    });
});
