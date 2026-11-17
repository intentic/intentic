import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { noteSubagentTask, resetSubagents, type SubagentTaskMessage } from "../../subagents.js";
import { childNamed, waitTargetOf, waitTargetsOf } from "../wait-targets.js";

/* 2026-11-17, the shinobi-society audit: `wait` on the agentId Claude Code's Agent tool handed back a second earlier came
   back `unknown-target`, since the roster knew the child only by its tool call's id until its meta file was read. */

const actors = memoryFleet().conversations;
let dir = "";
beforeEach(async () => {
    resetSubagents(actors);
    dir = await mkdtemp(join(tmpdir(), "wait-targets-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const started = (toolUseId: string, taskId: string): SubagentTaskMessage => ({
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "Resolve rebase conflicts",
    subagent_type: "general-purpose",
});

const born = (conversationId: string, toolUseId: string, taskId: string): void => {
    noteSubagentTask({ conversationId, conversations: actors, subagentsDir: dir }, started(toolUseId, taskId));
};

describe("a wait's target", () => {
    it("finds an in-process child by its agentId once its meta file is there, though nothing paired it yet", async () => {
        born("conv-w", "toolu_01", "task-1");
        await writeFile(join(dir, "agent-a731a0e817fc9b35c.meta.json"), JSON.stringify({ toolUseId: "toolu_01" }));
        expect(childNamed(actors, "conv-w", "a731a0e817fc9b35c")).toBeUndefined();
        expect(await waitTargetOf(actors, "conv-w", "a731a0e817fc9b35c", undefined, 0)).toBe("toolu_01");
    });

    it("finds a child by the task id the CLI gave it, and never another conversation's", () => {
        born("conv-w", "toolu_02", "a-task-id");
        expect(childNamed(actors, "conv-w", "a-task-id")?.id).toBe("toolu_02");
        expect(childNamed(actors, "conv-other", "a-task-id")).toBeUndefined();
    });

    it("gives a child whose start the stream has not delivered yet a moment to appear", async () => {
        const waited = waitTargetOf(actors, "conv-w", "task-late", undefined, 2_000);
        setTimeout(() => born("conv-w", "toolu_03", "task-late"), 300);
        expect(await waited).toBe("toolu_03");
    });

    it("hands back a name that matches nothing as given, and leaves any, all and no name alone", async () => {
        expect(await waitTargetOf(actors, "conv-w", "nobody", undefined, 0)).toBe("nobody");
        expect(await waitTargetOf(actors, "conv-w", "any")).toBe("any");
        expect(await waitTargetOf(actors, "conv-w", undefined)).toBeUndefined();
        expect(await waitTargetsOf(actors, "conv-w", undefined)).toBeUndefined();
    });
});
