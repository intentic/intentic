import { sdk } from "../claude/claude-sdk.js";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { subagentAgentId, subagentSource } from "../agent/subagents.js";
import { turnRunOf } from "../agent/turn-runs.js";
import type { TranscriptAgent } from "./agent-transcript.js";
import { restoredSessionMessages } from "./sessions.js";

/* ONE SUBAGENT'S TRANSCRIPT, in the shape every other transcript route already answers in.
 *
 * The split here is the one the daemon already makes for a conversation, and it is why surfacing a subagent needed
 * no new streaming channel: a RUNNING child is served from the live run (the parent turn's own fold for an SDK
 * child, tagged with the call that spawned it; its own run's rows for a spawned one), and a FINISHED one is
 * served from whatever store actually ran it:
 *   • subagent, the SDK writes a per-child JSONL beside its session's, and exposes getSubagentMessages over it.
 *     Reduced by restoredSessionMessages, so a child's cards read like its parent's.
 *   • spawned, a conversation of its own, so its settled record is the conversation's transcript record, read
 *     under the same (id, provider, harness) its turns were filed under.
 *
 * An empty result is a real answer: a child that has produced nothing yet, or one whose store has been swept. The
 * caller renders "nothing recorded" rather than an error, the same way a conversation with no transcript does. */

// What a read needs from the composition, threaded in rather than imported: this module is reached from a
// route, which has the services, and importing them here would tie a transcript reader to the container.
export interface SubagentTranscriptDeps {
    readonly root: string;
    // A spawned child is a conversation of its own, so its settled record is the conversation's transcript
    // record, read under the same (id, provider, harness) its turns were filed under.
    readonly conversation: (agent: TranscriptAgent) => Promise<TranscriptRow[]>;
}

export const readSubagentTranscript = async (deps: SubagentTranscriptDeps, id: string): Promise<TranscriptRow[]> => {
    const source = subagentSource(id);
    if (source === undefined) {
        return [];
    }
    /* WHILE IT RUNS, the parent's run is the only complete account, and for a subagent it is a BETTER one than
     * the file, because the frames were normalized on their way through (display names, call-time diffs) by the
     * same helpers a card is built from. `prompt` is what it was asked to do (the registry's description), put
     * first as the opening user bubble so the transcript reads like a conversation rather than starting
     * mid-answer. */
    if (source.kind === "subagent" && source.running) {
        const run = turnRunOf(source.conversationId);
        if (run !== undefined) {
            const prompt = source.description;
            return [...(prompt !== undefined && prompt.length > 0 ? [{ role: "user" as const, text: prompt }] : []), ...run.rowsOf(id)];
        }
    }
    if (source.kind === "subagent") {
        // Both ids are needed and either can be missing: the session's is the turn's own, and the child's is
        // paired to the spawning tool call out of the SDK's meta files here, at read time (subagentAgentId says
        // why it cannot be known earlier). A child from a session neither ever named has no file to point at.
        const agentId = await subagentAgentId(id);
        if (source.sessionId === undefined || agentId === undefined) {
            return [];
        }
        const messages = await sdk().getSubagentMessages(source.sessionId, agentId, { dir: source.cwd });
        return restoredSessionMessages(messages, deps.root);
    }
    /* A SPAWNED child is a conversation of its own, and the record's id IS that conversation's id, so both
     * halves of the split read the stores a conversation already writes: live from its own detached run (whose
     * rows open with what it was asked), settled from the conversation's transcript record, under the provider
     * and harness key its turns were filed with. */
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
