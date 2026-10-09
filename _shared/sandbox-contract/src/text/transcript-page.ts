import type { ToolCallContent } from "../events/requests.js";
import type { TranscriptRow, TranscriptTool } from "../events/transcript.js";

// WHAT A TRANSCRIPT PAGE CARRIES OF A ROW, written once for both ends: the daemon fits every row of a page it serves to
// this (sessions/agent-transcript.ts), and the editor fits the rows it mirrors to disk the same way, so a reopened chat
// paints from its mirror exactly the rows the daemon's page then hands back, and keeps them rather than drawing them
// again (transcriptState.ts rebuildKeeping matches rows by their contents).

// What a page carries of one tool output: the pane truncates text at 4000 characters of its own accord
// (toolPresentation.ts TEXT_CAP), so twice that leaves room to raise that cap without a second round trip.
export const PAGE_TEXT_CAP = 8_000;

const fitContent = (entry: ToolCallContent): ToolCallContent =>
    entry.type === "text" && entry.text.length > PAGE_TEXT_CAP ? { ...entry, text: entry.text.slice(0, PAGE_TEXT_CAP) } : entry;

// A delegation's own calls are left behind, counted rather than carried: the card draws collapsed until it is opened,
// and the daemon answers that press with the calls themselves. On the records this was measured on they were 86% of the
// bytes of the longest conversation.
const fitPageTool = (tool: TranscriptTool): TranscriptTool => {
    const { children, content, ...carried } = tool;
    return {
        ...carried,
        ...(content !== undefined ? { content: content.map(fitContent) } : {}),
        ...(children !== undefined && children.length > 0 ? { nested: children.length } : {}),
    };
};

/** A row as a page carries it; a row with no calls is handed back as it is. */
export const fitPageRow = <Row extends TranscriptRow>(row: Row): Row =>
    row.tools === undefined ? row : { ...row, tools: row.tools.map(fitPageTool) };

/** A call with everything under it, each output at every depth fitted the same way: what an opened delegation draws. */
export const fitNestedTool = (tool: TranscriptTool): TranscriptTool => ({
    ...tool,
    ...(tool.content !== undefined ? { content: tool.content.map(fitContent) } : {}),
    ...(tool.children !== undefined ? { children: tool.children.map(fitNestedTool) } : {}),
});
