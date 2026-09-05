import type { AgentHarness, AgentProvider, TranscriptRow } from "@intentic/sandbox-contract";
import type { TurnAnchor, TurnAnchors } from "../agent/turn-anchors.js";
import { type SpokenLine, spokenLinesOf } from "./transcript-search.js";
import type { TranscriptPage, TranscriptRecord, TranscriptWindow } from "./transcript-record.js";

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
const stampAnchors = (messages: readonly TranscriptRow[], anchors: ReadonlyMap<number, TurnAnchor>, from: number): TranscriptRow[] => {
    if (anchors.size === 0) {
        return [...messages];
    }
    const stamped: TranscriptRow[] = [];
    for (const [offset, message] of messages.entries()) {
        /* THE POSITION IN THE WHOLE RECORD, never in the page. `rewindIndex` is what the rewind route
         * addresses, what a fork counts to and what an anchor is filed under, so a window that numbered its
         * rows from zero would hand back indices naming a different message than the one on screen: click the
         * sixth turn of a page, rewind the sixth turn of the conversation. The window slides; these do not. */
        const index = from + offset;
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

/* THE WHOLE CONVERSATION, for the readers that cannot be given a piece of one: a share published as a page
 * with no daemon behind it, a runtime handoff seeding a replacement session, a subagent's record, an agent
 * recalling what was said. Truncating any of those is not a slower answer, it is a wrong one — a handoff
 * served the last twenty turns would amputate the agent's memory on every provider switch, silently.
 *
 * A tab OPENING a conversation wants `agentTranscriptPage` instead. This one's cost is the conversation's
 * whole length, which is why the display route stopped calling it. */
export const agentTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<TranscriptRow[]> =>
    stampAnchors(await deps.record.read(agent.id), await deps.turnAnchors.all(agent.id), 0);

/* ONE PAGE OF IT, for a client reopening a chat: the most recent turns, and where they sit, so the chat can
 * go back for the rest. What a reopened tab actually needs, and the only read on the click path.
 *
 * Each user message is stamped with the state it can be put back to, looked up per read rather than stored in
 * the record. That is the point: a rewind rewrites those anchors, so reading them fresh is what makes a
 * reopened tab offer exactly the turns still there to go back to, where a value frozen into the record would
 * keep offering turns a previous rewind already dropped. The lookup is one small file read for the whole
 * conversation, on a path that is already reading the transcript. */
export const agentTranscriptPage = async (deps: AgentTranscriptDeps, agent: TranscriptAgent, window: TranscriptWindow = {}): Promise<TranscriptPage> => {
    const page = await deps.record.window(agent.id, window);
    return { ...page, rows: stampAnchors(page.rows, await deps.turnAnchors.all(agent.id), page.from) };
};

/* What a conversation SAID, for the search index to store. Read on the BACKFILL and on a rewind, never on a
 * query: /agents/search asks the index, which already holds this.
 *
 * There used to be a process-lifetime cache here, keyed on the record's byte size, because the search read
 * this for every registry entry on every settled keystroke. It fixed the repeat and not the first hit: the
 * first phrase search after a boot still re-read and re-validated every transcript in the workspace (measured:
 * 545 MB of records, ~2.6 s of blocking parse, on top of 8 s of session files) and it held 24 MB of extracted
 * text in the heap forever afterwards. The index made both unnecessary, so the cache is gone rather than
 * layered on top of a second one.
 *
 * The WHOLE record, deliberately, where the display read above takes a window: a phrase typed into the box
 * has to find the turn it was said in whether that was this morning or last week, and an index built from the
 * tail would answer confidently about a conversation it had only read the end of. It reads the record
 * directly rather than through `agentTranscript` because rewind anchors are display's business: search wants
 * the words, and stamping every row with a checkpoint it will not look at is a second file read and a second
 * copy of the transcript per indexed conversation. */
export const spokenTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<readonly SpokenLine[]> =>
    spokenLinesOf(await deps.record.read(agent.id));
