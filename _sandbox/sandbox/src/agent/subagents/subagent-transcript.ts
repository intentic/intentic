import type { TranscriptRow } from "@intentic/sandbox-contract";
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
}

type Source = NonNullable<ReturnType<typeof subagentSource>>;

// An SDK child: while running, the parent's fold beats the file (normalized), `prompt` opening as the first user
// bubble; finished, its own JSONL. Both ids can be missing: the session's is the turn's own; the child pairs to its
// spawning call at read time.
const sdkChildTranscript = async (deps: SubagentTranscriptDeps, id: string, source: Source): Promise<TranscriptRow[]> => {
    const run = source.running ? turnRunOf(deps.conversations, source.conversationId) : undefined;
    if (run !== undefined) {
        const prompt = source.description;
        return [...(prompt !== undefined && prompt.length > 0 ? [{ role: "user" as const, text: prompt }] : []), ...run.rowsOf(id)];
    }
    const agentId = await subagentAgentId(deps.conversations, id);
    if (source.sessionId === undefined || agentId === undefined) {
        return [];
    }
    const messages = await sdk().getSubagentMessages(source.sessionId, agentId, { dir: source.cwd });
    return restoredSessionMessages(messages, deps.root);
};

export const readSubagentTranscript = async (deps: SubagentTranscriptDeps, id: string): Promise<TranscriptRow[]> => {
    const source = subagentSource(deps.conversations, id);
    if (source === undefined) {
        return [];
    }
    if (source.kind === "subagent") {
        return sdkChildTranscript(deps, id, source);
    }
    // A spawned child's id IS its conversation's id, so both live and settled paths read the stores a conversation
    // already writes.
    const run = source.running ? turnRunOf(deps.conversations, id) : undefined;
    if (run !== undefined) {
        return [...run.rows];
    }
    return deps.conversation({ id });
};
