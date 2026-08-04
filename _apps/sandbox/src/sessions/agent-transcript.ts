import { type AgentHarness, type AgentProvider, capabilitiesOf, type RestoredMessage } from "@intentic/sandbox-contract";
import type { RewindPoints } from "../agent/rewind-points.js";
import { readCodexSession } from "./codex-sessions.js";
import { userPromptsOf } from "./prompt-index.js";
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
    // Which checkpoint each message can be rewound to — read per transcript, never stored in it (see below).
    readonly rewindPoints: RewindPoints;
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
 * and adding one to make its chats open would mean its turns are bypassing the record. transcript-record.integration.test.ts
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

/* A conversation's transcript, for a client reopening it. The record is authoritative wherever it exists — it is
 * what the daemon streamed — and it exists for every conversation that has run a turn since it was introduced,
 * including the ones no provider store would answer for.
 *
 * Each user message is stamped with the checkpoint it can be rewound to, looked up per read rather than stored
 * in the record. That is the point: a rewind rewrites those points, so reading them fresh is what makes a
 * reopened tab offer exactly the turns still there to go back to — where a value frozen into the record would
 * keep offering turns a previous rewind already dropped. The lookup is one small file read for the whole
 * conversation, on a path that is already reading the transcript. */
export const agentTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<RestoredMessage[]> => {
    const recorded = await deps.record.read(agent.id);
    const messages = recorded.length > 0 ? recorded : await storedTranscript(deps, agent);
    const points = await deps.rewindPoints.all(agent.id);
    if (points.size === 0) {
        return messages;
    }
    const stamped: RestoredMessage[] = [];
    for (const [index, message] of messages.entries()) {
        // Only user bubbles carry one — an assistant message is not a point anyone can go back TO — and only
        // where a checkpoint exists, so an offer on screen is one the rewind route will honour.
        const checkpointId = message.role === "user" ? points.get(index) : undefined;
        stamped.push(checkpointId === undefined ? message : { ...message, checkpointId });
    }
    return stamped;
};

/* A conversation's USER prompts, cached — because /agents/search asks for them for every registry entry, live
 * and archived, on every settled keystroke. Answering that from agentTranscript meant re-reading and
 * re-validating the entire transcript store (plus the provider-store backfill for pre-record conversations)
 * per keystroke: measured multi-second event-loop stalls that wedged every other request behind the search,
 * including the transcript read of the very chat the user then clicked.
 *
 * The record's byte size is the cache key. The file is append-only, so an unchanged size is an unchanged
 * record; a turn settling grows it and the next probe re-reads. A conversation still on the backfill has no
 * record and so no size, and stays cached against `undefined` until one exists — which the first settled turn
 * creates by appending (a turn whose adoption came back empty deliberately does not, see transcript-record's
 * `open`). So the backfill's prompts can be served for the length of one turn after the provider store behind
 * them moved; the window closes the moment anything is recorded. The prompt a LIVE turn is running on is not
 * this function's problem either: the route unions it in from the routed-prompt index (conversationPrompts),
 * the same way the session search covers its own write-lag window. */
export const createAgentPromptsReader = (deps: AgentTranscriptDeps): ((agent: TranscriptAgent) => Promise<readonly string[]>) => {
    const cache = new Map<string, { size: number | undefined; prompts: readonly string[] }>();
    return async (agent) => {
        const size = await deps.record.size(agent.id);
        const held = cache.get(agent.id);
        if (held !== undefined && held.size === size) {
            return held.prompts;
        }
        const prompts = userPromptsOf(await agentTranscript(deps, agent));
        cache.set(agent.id, { size, prompts });
        return prompts;
    };
};
