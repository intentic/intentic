import type { AgentEvent } from "./agent-events.js";
import type { TranscriptTool } from "./transcript.js";

// The fields a tool_call_update sets on its card by plain replacement (transcript-fold.ts keeps the status and the
// content, which each move something else too), and the input a card that still has neither target nor input takes:
// an ACP agent (Devin) sends a call's arguments only on its updates, and until 2026-10-27 57% of its cards since 10-23
// were left with none.
export const takeToolUpdate = (tool: TranscriptTool, event: Extract<AgentEvent, { kind: "tool_call_update" }>): void => {
    if (event.exitCode !== undefined) {
        tool.exitCode = event.exitCode;
    }
    if (event.locations !== undefined) {
        tool.locations = event.locations;
    }
    if (event.input !== undefined && tool.target === undefined && tool.input === undefined) {
        tool.input = event.input;
    }
};
