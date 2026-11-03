import { cancelledRequests } from "../policy/request-status.js";
import { isAwaitingDecision, type TranscriptRow, type TranscriptTool } from "../events/transcript.js";

// A turn cannot leave a call running, including a helper's nested calls.
export const interruptTools = (tools: readonly TranscriptTool[], at: number | undefined): boolean => {
    let changed = false;
    for (const tool of tools) {
        if (tool.status === "pending" || tool.status === "in_progress") {
            tool.status = "interrupted";
            if (at !== undefined) {
                tool.endedAt = at;
            }
            changed = true;
        }
        changed = interruptTools(tool.children ?? [], at) || changed;
    }
    return changed;
};

/** Freeze decisions whose waiter ended, and calls whose result will no longer arrive. */
export const interruptAssistant = (row: TranscriptRow, at: number | undefined): boolean => {
    if (row.role !== "assistant") {
        return false;
    }
    const awaiting = isAwaitingDecision(row);
    if (awaiting) {
        Object.assign(row, cancelledRequests(row));
    }
    return interruptTools(row.tools ?? [], at) || awaiting;
};
