import { type AgentHarness, type AgentProvider, capabilitiesOf, type RestoredMessage } from "@intentic/sandbox-contract";
import { readCodexSession } from "./codex-sessions.js";
import type { TranscriptRecord } from "./transcript-record.js";

// Which conversation to answer about. The provider/harness pair is the REGISTRY's, never re-derived from the
// turn that happens to be running: a conversation that switched provider mid-way is still one transcript.
export interface TranscriptAgent {
    readonly id: string;
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
}

export interface AgentTranscriptDeps {
    readonly record: TranscriptRecord;
    readonly root: string;
    readonly codexHome: string;
    /* Which SDK session holds this conversation's turns — asked of the REGISTRY, which recorded it from the
     * turn's own `session` frame, never re-derived from where the turn happened to run. An isolated turn runs in
     * a mount namespace where its worktree IS the workspace root (agents/isolation.ts), so the SDK files the
     * session under the root's project key and the worktree path is not a project key at all. */
    readonly sessionIdOf: (conversationId: string) => string | undefined;
    readonly readClaudeSession: (dir: string, id: string) => Promise<RestoredMessage[]>;
}

/* THE ONLY PROVIDER-SHAPED READ LEFT, and it is a backfill: the conversations that ran before the daemon kept a
 * transcript of its own (sessions/transcript-record.ts). Everything from here on records as it streams, whatever
 * provider served it, so this list does NOT grow with the provider catalog — a new provider needs no entry here,
 * and adding one to make its chats open would mean its turns are bypassing the record. transcript-record.test.ts
 * is the guard that says so.
 *
 * Empty is a legitimate answer (a conversation with no store to read, or one whose store no longer holds it),
 * and it is not an error — the record simply opens with nothing adopted. */
export const storedTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<RestoredMessage[]> => {
    // Which store to backfill from is the RUNTIME's question, not the provider's — a codex conversation on the
    // claude-code harness filed its turns with the SDK, not in a codex rollout (capabilitiesOf).
    const { runtime } = capabilitiesOf(agent.provider, agent.harness);
    if (runtime === "claude-code") {
        const sessionId = deps.sessionIdOf(agent.id);
        return sessionId === undefined ? [] : deps.readClaudeSession(deps.root, sessionId);
    }
    if (runtime === "codex") {
        const threadId = deps.sessionIdOf(agent.id);
        return threadId === undefined ? [] : readCodexSession(deps.codexHome, threadId, deps.root);
    }
    return [];
};

// A conversation's transcript, for a client reopening it. The record is authoritative wherever it exists — it is
// what the daemon streamed — and it exists for every conversation that has run a turn since it was introduced,
// including the ones no provider store would answer for.
export const agentTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<RestoredMessage[]> => {
    const recorded = await deps.record.read(agent.id);
    return recorded.length > 0 ? recorded : storedTranscript(deps, agent);
};
