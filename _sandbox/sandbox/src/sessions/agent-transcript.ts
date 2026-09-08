import type { AgentHarness, AgentProvider, TranscriptRow } from "@intentic/sandbox-contract";
import type { TurnAnchor, TurnAnchors } from "../agent/anchors/turn-anchors.js";
import { type SpokenLine, spokenLinesOf } from "./transcript-search.js";
import type { TranscriptPage, TranscriptRecord, TranscriptWindow } from "./transcript-record.js";

// Which conversation to answer about; provider/harness are the registry's, never re-derived from the running turn, so a
// mid-conversation provider switch is still one transcript.
export interface TranscriptAgent {
    readonly id: string;
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
}

export interface AgentTranscriptDeps {
    readonly record: TranscriptRecord;
    // What each message can be put back to, read per transcript, never stored in it.
    readonly turnAnchors: TurnAnchors;
}

// Stamps each user message with the state it can be put back to, read fresh per call so a rewind's effect appears
// immediately, not a value frozen into the record. One small file read for the whole conversation.
const stampAnchors = (messages: readonly TranscriptRow[], anchors: ReadonlyMap<number, TurnAnchor>, from: number): TranscriptRow[] => {
    if (anchors.size === 0) {
        return [...messages];
    }
    const stamped: TranscriptRow[] = [];
    for (const [offset, message] of messages.entries()) {
        // Position in the whole record, never the page: `rewindIndex` must survive the window sliding.
        const index = from + offset;
        // Only user messages can carry an anchor; what rides along is its identity (a checkpoint id, or the turn's own
        // commit name), with the index rewind addresses, so the client never counts rows or opens the checkpoint
        // itself.
        const anchor = message.role === "user" ? anchors.get(index) : undefined;
        const checkpointId = anchor === undefined ? undefined : anchor.kind === "tree" ? anchor.snapshot : `worktree:${index}`;
        stamped.push(checkpointId === undefined ? message : { ...message, checkpointId, rewindIndex: index });
    }
    return stamped;
};

// The whole conversation, for readers that cannot be given a piece of one (a share, a handoff, a subagent record):
// truncating would be wrong, not just slower. A tab opening a chat wants `agentTranscriptPage`, which costs less.
export const agentTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<TranscriptRow[]> =>
    stampAnchors(await deps.record.read(agent.id), await deps.turnAnchors.all(agent.id), 0);

// One page of a conversation, for a reopening tab: the most recent turns and where they sit, so the chat can page back
// for the rest. The only read on the click path.
export const agentTranscriptPage = async (deps: AgentTranscriptDeps, agent: TranscriptAgent, window: TranscriptWindow = {}): Promise<TranscriptPage> => {
    const page = await deps.record.window(agent.id, window);
    return { ...page, rows: stampAnchors(page.rows, await deps.turnAnchors.all(agent.id), page.from) };
};

// What a conversation said, for the search index (backfill and rewind, never a live query). Reads the whole record, not
// a window, and skips agentTranscript to avoid stamping every row with a checkpoint search never uses.
export const spokenTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<readonly SpokenLine[]> =>
    spokenLinesOf(await deps.record.read(agent.id));
