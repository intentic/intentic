import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { sdk } from "../../engines/claude-sdk.js";
import type { TranscriptAgent } from "../../sessions/agent-transcript.js";
import { restoredSessionMessages } from "../../sessions/sessions.js";
import { subagentAgentId, subagentSource } from "./subagents.js";

// One subagent's transcript, in the shape other transcript routes answer in. Running is served live (the parent's fold
// for an SDK child, its own run for a spawned one); finished, from whichever store ran it:
// - subagent: the SDK's per-child JSONL, reduced like a parent's session
// - spawned: its own conversation's transcript record
// An empty result is real: nothing recorded yet, or a swept store.

// What a read needs from the composition, threaded in rather than imported, so a transcript reader isn't tied to the
// container.
export interface SubagentTranscriptDeps {
    readonly root: string;
    // Where a running child's live run is held, and its parent's.
    readonly conversations: Pick<ConversationActors, "holdings">;
    // Reads a spawned child's settled record as its own conversation's.
    readonly conversation: (agent: TranscriptAgent) => Promise<TranscriptRow[]>;
    // The calls a delegation's card holds in its parent's settled record: what is left of a subagent some runtime ran
    // in-process once its run is gone, where no SDK store of its own exists to read.
    readonly toolChildren: (agent: TranscriptAgent, toolId: string) => Promise<TranscriptTool[]>;
}

type Source = NonNullable<ReturnType<typeof subagentSource>>;

// The subagent's ask, as the first user bubble; its frames carry no prompt of their own.
const askedOf = (source: Source): TranscriptRow[] =>
    source.description !== undefined && source.description.length > 0 ? [{ role: "user", text: source.description }] : [];

// An in-process child: while running, the parent's fold beats the file (normalized); finished, the Claude SDK's own
// JSONL. Both ids can be missing: the session's is the turn's own; the child pairs to its spawning call at read time.
// Any other runtime keeps no such file, so a finished one reads from its parent: the run while it is still held, then
// the calls its card kept in the parent's record.
const inProcessTranscript = async (deps: SubagentTranscriptDeps, id: string, source: Source): Promise<TranscriptRow[]> => {
    const run = turnRunOf(deps.conversations, source.conversationId);
    if (source.running && run !== undefined) {
        return [...askedOf(source), ...run.rowsOf(id)];
    }
    const agentId = await subagentAgentId(deps.conversations, id);
    if (source.sessionId !== undefined && agentId !== undefined) {
        const messages = await sdk().getSubagentMessages(source.sessionId, agentId, { dir: source.cwd });
        return restoredSessionMessages(messages, deps.root);
    }
    const held = run?.rowsOf(id) ?? [];
    if (held.length > 0) {
        return [...askedOf(source), ...held];
    }
    const kept = await deps.toolChildren({ id: source.conversationId }, id);
    return kept.length === 0 ? [] : [...askedOf(source), { role: "assistant", text: "", tools: kept }];
};

export const readSubagentTranscript = async (deps: SubagentTranscriptDeps, id: string): Promise<TranscriptRow[]> => {
    const source = subagentSource(deps.conversations, id);
    if (source === undefined) {
        return [];
    }
    if (source.kind === "subagent") {
        return inProcessTranscript(deps, id, source);
    }
    // A spawned child's id IS its conversation's id, so both live and settled paths read the stores a conversation
    // already writes.
    const run = source.running ? turnRunOf(deps.conversations, id) : undefined;
    if (run !== undefined) {
        return [...run.rows];
    }
    return deps.conversation({ id });
};
