import { type AgentHarness, type AgentProvider, capabilitiesOf, type RestoredMessage } from "@intentic/sandbox-contract";
import type { TurnAnchors } from "../agent/turn-anchors.js";
import { readCodexSession } from "./codex-sessions.js";
import { type SpokenLine, spokenLinesOf } from "./transcript-search.js";
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
    // What each message can be put back to, read per transcript, never stored in it (see below).
    readonly turnAnchors: TurnAnchors;
    readonly root: string;
    readonly codexHome: string;
    /* Which SDK session holds this conversation's turns, asked of the REGISTRY, which recorded it from the
     * turn's own `session` frame, never re-derived from where the turn happened to run. An isolated turn runs in
     * a mount namespace where its worktree IS the workspace root (agents/isolation.ts), so the SDK files the
     * session under the root's project key and the worktree path is not a project key at all. */
    readonly sessionIdOf: (conversationId: string) => string | undefined;
    readonly readClaudeSession: (dir: string, id: string) => Promise<RestoredMessage[]>;
}

/* THE ONLY PROVIDER-SHAPED READ LEFT, and it is a backfill: the conversations that ran before the daemon kept a
 * transcript of its own (sessions/transcript-record.ts). Everything from here on records as it streams, whatever
 * provider served it, so this list does NOT grow with the provider catalog, a new provider needs no entry here,
 * and adding one to make its chats open would mean its turns are bypassing the record. transcript-record.integration.test.ts
 * is the guard that says so.
 *
 * Empty is a legitimate answer (a conversation with no store to read, or one whose store no longer holds it),
 * and it is not an error, the record simply opens with nothing adopted. */
export const storedTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<RestoredMessage[]> => {
    // Which store to backfill from is the RUNTIME's question, not the provider's, a codex conversation on the
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

/* A conversation's transcript, for a client reopening it. The record is authoritative wherever it exists, it is
 * what the daemon streamed, and it exists for every conversation that has run a turn since it was introduced,
 * including the ones no provider store would answer for.
 *
 * Each user message is stamped with the state it can be put back to, looked up per read rather than stored in
 * the record. That is the point: a rewind rewrites those anchors, so reading them fresh is what makes a
 * reopened tab offer exactly the turns still there to go back to, where a value frozen into the record would
 * keep offering turns a previous rewind already dropped. The lookup is one small file read for the whole
 * conversation, on a path that is already reading the transcript. */
export const agentTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<RestoredMessage[]> => {
    const recorded = await deps.record.read(agent.id);
    const messages = recorded.length > 0 ? recorded : await storedTranscript(deps, agent);
    const anchors = await deps.turnAnchors.all(agent.id);
    if (anchors.size === 0) {
        return messages;
    }
    const stamped: RestoredMessage[] = [];
    for (const [index, message] of messages.entries()) {
        /* Only user bubbles carry one, an assistant message is not a point anyone can go back TO, and only
         * where an anchor exists, so an offer on screen is one the daemon will honour.
         *
         * What rides up is the anchor's IDENTITY, not its contents: a checkpoint id where there is one, else
         * the conversation's own name for that turn's commits. The client never opens it, it reads it as
         * "there is a state here" and hands the message's index back when it wants to use it, so the two
         * placements need no separate field, and a client cannot address a commit the daemon did not choose. */
        const anchor = message.role === "user" ? anchors.get(index) : undefined;
        const checkpointId = anchor === undefined ? undefined : anchor.kind === "tree" ? anchor.snapshot : `worktree:${index}`;
        stamped.push(checkpointId === undefined ? message : { ...message, checkpointId });
    }
    return stamped;
};

/* What a conversation SAID, for the search index to store. Read on the BACKFILL and on a rewind, never on a
 * query: /agents/search asks the index, which already holds this.
 *
 * There used to be a process-lifetime cache here, keyed on the record's byte size, because the search read
 * this for every registry entry on every settled keystroke. It fixed the repeat and not the first hit: the
 * first phrase search after a boot still re-read and re-validated every transcript in the workspace (measured:
 * 545 MB of records, ~2.6 s of blocking parse, on top of 8 s of session files) and it held 24 MB of extracted
 * text in the heap forever afterwards. The index made both unnecessary, so the cache is gone rather than
 * layered on top of a second one. */
export const spokenTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<readonly SpokenLine[]> =>
    spokenLinesOf(await agentTranscript(deps, agent));
