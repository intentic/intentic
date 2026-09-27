import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent, TranscriptTool } from "@intentic/sandbox-contract";
import { withRuntimeSubagents } from "./runtime-subagents.js";
import { readSubagentTranscript, type SubagentTranscriptDeps } from "./subagent-transcript.js";
import { resetSubagents } from "./subagents.js";
import { memoryFleet } from "../../testing.js";

// Pins where a finished subagent of a runtime other than the Claude loop is read back from. Such a runtime keeps no
// per-subagent store the way the Claude SDK does, so once its run is gone what is left is what the delegating call's
// card kept in its parent's record.

const actors = memoryFleet().conversations;

const kept: TranscriptTool[] = [{ id: "e1", name: "Edit", category: "edit", status: "completed" }];

const deps = (children: readonly TranscriptTool[], asked: string[]): SubagentTranscriptDeps => ({
    root: WORKSPACE_ROOT,
    conversations: actors,
    conversation: async () => [],
    toolChildren: async (agent, toolId) => {
        asked.push(`${agent.id}/${toolId}`);
        return [...children];
    },
});

// Files a runtime's subagent the way its adapter's frames do, and ends it.
const finished = async (frames: readonly AgentEvent[]): Promise<void> => {
    async function* reported(): AsyncGenerator<AgentEvent> {
        yield* frames;
    }
    for await (const frame of withRuntimeSubagents(reported(), { conversationId: "conv-t", conversations: actors, cwd: WORKSPACE_ROOT, sessionId: undefined, subagentsDir: undefined })) {
        void frame;
    }
};

beforeEach(() => resetSubagents(actors));

test("a finished runtime subagent reads as its ask and the calls its card kept in the parent's record", async () => {
    await finished([
        { kind: "subagent", id: "task-1", subagentKind: "subagent", description: "Map the reads" },
        { kind: "subagent_update", id: "task-1", status: "completed", summary: "Mapped." },
    ]);
    const asked: string[] = [];

    expect(await readSubagentTranscript(deps(kept, asked), "task-1")).toEqual([
        { role: "user", text: "Map the reads" },
        { role: "assistant", text: "", tools: kept },
    ]);
    expect(asked).toEqual(["conv-t/task-1"]);
});

test("one whose card kept nothing reads as nothing recorded, not as a bare ask", async () => {
    await finished([{ kind: "subagent", id: "task-2", subagentKind: "subagent", description: "Try it" }]);

    expect(await readSubagentTranscript(deps([], []), "task-2")).toEqual([]);
});
