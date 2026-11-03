import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { transcriptPageOf } from "../../../sessions/agent-transcript.js";
import { lostHelperNote } from "../recovery/lost-helpers.js";

const agentId = "a0123456789abcdef";
const history: TranscriptRow[] = [{ role: "assistant", text: "", run: "cut-turn", tools: [{
    id: "call-1", name: "Agent", category: "execute", status: "completed",
    subagent: { kind: "subagent", status: "killed", description: "Fix the collider" },
    content: [{ type: "text", text: `agentId: ${agentId}\noutput_file: /tmp/claude/tasks/${agentId}.output` }],
}] }];

const servicesAt = (store: string): Pick<Services, "agents" | "agentWorktrees" | "transcripts"> => ({
    agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
    agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { sessionStore: () => store }),
    transcripts: unstubbed<Services["transcripts"]>("transcripts", { page: async () => transcriptPageOf(history) }),
});

test("a hand-off names helpers, their retained edits and their partial outputs without blaming the user", async () => {
    const root = await mkdtemp(join(tmpdir(), "lost-helpers-"));
    try {
        await mkdir(join(root, ".claude/worktrees", `agent-${agentId}`), { recursive: true });
        const note = await lostHelperNote(servicesAt(root), {
            conversationId: "parent", sessionId: undefined, history, localCwd: root, reason: "allowance hand-off",
        });
        expect(note).toEqual({
            title: "In-process helpers lost with the previous turn",
            text: `The sandbox ended these in-process helpers when the previous turn ended (allowance hand-off). This was not a user stop. They cannot receive SendMessage or continue running. Inspect their retained worktrees and partial output before assigning their unfinished work again. A container recreation may have cleared output under /tmp; keep recovered evidence in /work/.intentic/records/artifacts/.\n- ${agentId}: Fix the collider. Worktree: .claude/worktrees/agent-${agentId}. Partial work: edits in that worktree; saved tool calls in this conversation's helper card; output/record: /tmp/claude/tasks/${agentId}.output.`,
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("after restart it recovers an unpaired helper from durable cards and session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "lost-helpers-restart-"));
    try {
        const dir = join(root, "projects/project/session-1/subagents");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: "call-1" }));
        const note = await lostHelperNote(servicesAt(root), {
            conversationId: "parent", sessionId: "session-1", history: [], localCwd: root, reason: "sandbox restart",
        });
        expect(note?.text).toContain("This was not a user stop.");
        expect(note?.text).toContain(`${root}/projects/*/session-1/subagents/agent-${agentId}.jsonl`);
        expect(note?.text).toContain(".claude/worktrees/agent-* (check for a retained worktree)");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a helper that completed is not described as lost", async () => {
    const rows: TranscriptRow[] = [{ role: "assistant", text: "", tools: [{
        id: "call-done", name: "Agent", category: "execute", status: "completed",
        subagent: { kind: "subagent", status: "completed" },
    }] }];
    expect(await lostHelperNote(servicesAt("/unused"), {
        conversationId: "parent", sessionId: undefined, history: rows, localCwd: "/unused", reason: "sandbox restart",
    })).toBeUndefined();
});
