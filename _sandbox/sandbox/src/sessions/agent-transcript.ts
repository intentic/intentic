import type { AgentHarness, AgentProvider, TranscriptRow } from "@intentic/sandbox-contract";
import type { TurnAnchors } from "../agent/turn-anchors.js";
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
}

/* A conversation's transcript, for a client reopening it: the daemon's own record, what it streamed, written
 * down as each turn settled, for every conversation that has run a turn, including the ones no provider store
 * would answer for.
 *
 * Each user message is stamped with the state it can be put back to, looked up per read rather than stored in
 * the record. That is the point: a rewind rewrites those anchors, so reading them fresh is what makes a
 * reopened tab offer exactly the turns still there to go back to, where a value frozen into the record would
 * keep offering turns a previous rewind already dropped. The lookup is one small file read for the whole
 * conversation, on a path that is already reading the transcript. */
export const agentTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<TranscriptRow[]> => {
    const messages = await deps.record.read(agent.id);
    const anchors = await deps.turnAnchors.all(agent.id);
    if (anchors.size === 0) {
        return messages;
    }
    const stamped: TranscriptRow[] = [];
    for (const [index, message] of messages.entries()) {
        /* Only user bubbles carry one, an assistant message is not a point anyone can go back TO, and only
         * where an anchor exists, so an offer on screen is one the daemon will honour.
         *
         * What rides up is the anchor's IDENTITY, not its contents: a checkpoint id where there is one, else
         * the conversation's own name for that turn's commits. The client never opens it, it reads it as
         * "there is a state here" and hands the message's index back when it wants to use it, so the two
         * placements need no separate field, and a client cannot address a commit the daemon did not choose.
         * The index rides beside it, the position the rewind route addresses, so the client never counts rows
         * to find it. */
        const anchor = message.role === "user" ? anchors.get(index) : undefined;
        const checkpointId = anchor === undefined ? undefined : anchor.kind === "tree" ? anchor.snapshot : `worktree:${index}`;
        stamped.push(checkpointId === undefined ? message : { ...message, checkpointId, rewindIndex: index });
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
