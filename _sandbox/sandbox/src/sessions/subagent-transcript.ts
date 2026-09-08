import { sdk } from "../runtimes/claude/claude-sdk.js";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { subagentAgentId, subagentSource } from "../agent/subagents/subagents.js";
import { turnRunOf } from "../agent/run/turn/turn-runs.js";
import type { TranscriptAgent } from "./agent-transcript.js";
import { restoredSessionMessages } from "./sessions.js";

// One subagent's transcript, in the shape other transcript routes answer in. Running is served live (the parent's fold
// for an SDK child, its own run for a spawned one); finished, from whichever store ran it:
// - subagent: the SDK's per-child JSONL, reduced like a parent's session
// - spawned: its own conversation's transcript record
// An empty result is real: nothing recorded yet, or a swept store.

// What a read needs from the composition, threaded in rather than imported, so a transcript reader isn't tied to the
// container.
export interface SubagentTranscriptDeps {
    readonly root: string;
    // Reads a spawned child's settled record as its own conversation's, filed under (id, provider, harness).
    readonly conversation: (agent: TranscriptAgent) => Promise<TranscriptRow[]>;
}

export const readSubagentTranscript = async (deps: SubagentTranscriptDeps, id: string): Promise<TranscriptRow[]> => {
    const source = subagentSource(id);
    if (source === undefined) {
        return [];
    }
    // While running, the parent's fold beats the file (normalized); `prompt` opens as the first user bubble.
    if (source.kind === "subagent" && source.running) {
        const run = turnRunOf(source.conversationId);
        if (run !== undefined) {
            const prompt = source.description;
            return [...(prompt !== undefined && prompt.length > 0 ? [{ role: "user" as const, text: prompt }] : []), ...run.rowsOf(id)];
        }
    }
    if (source.kind === "subagent") {
        // Both ids can be missing: the session's is the turn's own; the child pairs to its spawning call at read time.
        const agentId = await subagentAgentId(id);
        if (source.sessionId === undefined || agentId === undefined) {
            return [];
        }
        const messages = await sdk().getSubagentMessages(source.sessionId, agentId, { dir: source.cwd });
        return restoredSessionMessages(messages, deps.root);
    }
    // A spawned child's id IS its conversation's id, so both live and settled paths read the stores a conversation
    // already writes, under the provider/harness its turns were filed with.
    if (source.running) {
        const run = turnRunOf(id);
        if (run !== undefined) {
            return [...run.rows];
        }
    }
    if (source.provider === undefined || source.harness === undefined) {
        return [];
    }
    return deps.conversation({ id, provider: source.provider, harness: source.harness });
};
