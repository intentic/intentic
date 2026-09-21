import type { AgentHarness, AgentProvider, ToolCallContent, TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import type { TurnCheckpoint, TurnCheckpoints } from "../agent/checkpoints/turn-checkpoints.js";
import { type SpokenLine, spokenLinesOf } from "./transcript-search.js";
import { type TranscriptPage, type TranscriptRecord, type TranscriptWindow, windowOf } from "./transcript-record.js";

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
    readonly turnCheckpoints: TurnCheckpoints;
}

// Stamps each user message with the state it can be put back to, read fresh per call so a rewind's effect appears
// immediately, not a value frozen into the record. One small file read for the whole conversation.
const stampAnchors = (messages: readonly TranscriptRow[], anchors: ReadonlyMap<number, TurnCheckpoint>, from: number): TranscriptRow[] => {
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
    stampAnchors(await deps.record.read(agent.id), await deps.turnCheckpoints.all(agent.id), 0);

// What a page carries of one tool call's output. The pane truncates text at 4000 characters of its own accord
// (toolPresentation.ts TEXT_CAP), so twice that leaves room to raise that cap without a second round trip, and drops the
// megabyte command dumps that make up most of a long conversation's bytes.
export const PAGE_TEXT_CAP = 8_000;

const fitContent = (entry: ToolCallContent): ToolCallContent =>
    entry.type === "text" && entry.text.length > PAGE_TEXT_CAP ? { ...entry, text: entry.text.slice(0, PAGE_TEXT_CAP) } : entry;

// A delegation's own calls are left behind, counted rather than carried: the card draws collapsed until it is opened,
// and `agentToolChildren` answers that press. On this workspace's records they are 86% of the bytes of the longest
// conversation.
const fitTool = (tool: TranscriptTool): TranscriptTool => {
    const { children, content, ...carried } = tool;
    return {
        ...carried,
        ...(content !== undefined ? { content: content.map(fitContent) } : {}),
        ...(children !== undefined && children.length > 0 ? { nested: children.length } : {}),
    };
};

const fitRow = (row: TranscriptRow): TranscriptRow => (row.tools === undefined ? row : { ...row, tools: row.tools.map(fitTool) });

// One page of a conversation, for a reopening tab: the most recent turns and where they sit, so the chat can page back
// for the rest. The only read on the click path, and the only one bounded in bytes.
// `fit` last: it is what makes this a page rather than a read, so a caller's window cannot opt out of it.
export const agentTranscriptPage = async (deps: AgentTranscriptDeps, agent: TranscriptAgent, window: TranscriptWindow = {}): Promise<TranscriptPage> => {
    const page = await deps.record.window(agent.id, { ...window, fit: fitRow });
    return { ...page, rows: stampAnchors(page.rows, await deps.turnCheckpoints.all(agent.id), page.from) };
};

// The same page, for a caller holding the whole record in memory: the route fakes answer through it, so a test cannot
// pass a page shape the daemon itself would not serve.
export const transcriptPageOf = (rows: readonly TranscriptRow[], window: TranscriptWindow = {}): TranscriptPage => windowOf(rows, { ...window, fit: fitRow });

// Depth-first, newest row back: a call's id is unique within a conversation, so the first hit is the only one.
const toolIn = (tools: readonly TranscriptTool[], id: string): TranscriptTool | undefined => {
    for (const tool of tools) {
        if (tool.id === id) {
            return tool;
        }
        const nested = toolIn(tool.children ?? [], id);
        if (nested !== undefined) {
            return nested;
        }
    }
    return undefined;
};

// Structure kept, text capped at every depth: an opened card draws the whole subtree, and the pane's own cap applies to
// each of those cards exactly as it does to a top-level one.
const fitNested = (tool: TranscriptTool): TranscriptTool => ({
    ...tool,
    ...(tool.content !== undefined ? { content: tool.content.map(fitContent) } : {}),
    ...(tool.children !== undefined ? { children: tool.children.map(fitNested) } : {}),
});

// Same lookup as `agentToolChildren`, for a caller that already holds the whole record in memory.
export const toolChildrenOf = (rows: readonly TranscriptRow[], toolId: string): TranscriptTool[] => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const found = toolIn(rows[index]?.tools ?? [], toolId);
        if (found !== undefined) {
            return (found.children ?? []).map(fitNested);
        }
    }
    return [];
};

// The calls under one tool card, for a delegation the page left counted. Read back out of the record, not the subagent
// registry: that is an in-memory map swept on a schedule, so it answers nothing for a conversation archived weeks ago.
export const agentToolChildren = async (deps: AgentTranscriptDeps, agent: TranscriptAgent, toolId: string): Promise<TranscriptTool[]> => {
    const found = await deps.record.findBack(agent.id, (row) => toolIn(row.tools ?? [], toolId) !== undefined);
    return found === undefined ? [] : toolChildrenOf([found], toolId);
};

// What a conversation said, for the search index (backfill and rewind, never a live query). Reads the whole record, not
// a window, and skips agentTranscript to avoid stamping every row with a checkpoint search never uses.
export const spokenTranscript = async (deps: AgentTranscriptDeps, agent: TranscriptAgent): Promise<readonly SpokenLine[]> =>
    spokenLinesOf(await deps.record.read(agent.id));
