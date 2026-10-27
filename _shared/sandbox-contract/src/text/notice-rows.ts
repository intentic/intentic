import type { AgentEvent } from "../events/agent-events.js";
import type { TranscriptRow } from "../events/transcript.js";
import { noticeCode } from "../events/sandbox-notice.js";
import { contextTrimLine, contextTrimNotice } from "../schemas/context-trim.js";
import { freshStartLine, freshStartNotice, handedOffLine, handedOffNotice } from "../schemas/providers/handoff.js";

// The notices that say what a turn was given to start from, each a row of its own worded from its frame's facts: what
// the window left out of the message, how a held turn continued, and where a home's session started over.
type StartingFrame = Extract<AgentEvent, { kind: "context_trim" | "handoff" | "fresh_start" }>;

/** A starting frame's row, in the English the record keeps, with the code a reader words it from. */
export const startingRow = (event: StartingFrame): TranscriptRow => {
    switch (event.kind) {
        case "context_trim":
            return { role: "notice", text: contextTrimLine(event), noticeCode: noticeCode(contextTrimNotice(event)) };
        case "handoff":
            return { role: "notice", text: handedOffLine(event), noticeCode: noticeCode(handedOffNotice(event)) };
        case "fresh_start":
            return { role: "notice", text: freshStartLine(event), noticeCode: noticeCode(freshStartNotice(event)) };
    }
};
