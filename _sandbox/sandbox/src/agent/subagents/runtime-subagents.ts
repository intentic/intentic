import type { AgentEvent } from "@intentic/sandbox-contract";
import { noteChildWork } from "./child-verification.js";
import { closeSubagents, fileReportedSubagent, type SubagentTurn } from "./subagents.js";

// A runtime's own subagents, carried to the roster from the frames its adapter yields: every runtime but the Claude
// Code loop, which files its own from the SDK's task stream (agent.ts). An adapter reports a subagent the way the Claude
// loop's stream does: `subagent` when its delegating call starts one, `subagent_update` as it moves and ends, and its
// own calls tagged with that call's id. Passing through here files each subagent, feeds the ledger that says whether
// anything checked its work, and closes, with the turn, any the runtime never ended, as the Claude loop does.

/** One frame on its way from a runtime's adapter to the turn: filed where it concerns a subagent, else passed on. */
const filed = (turn: SubagentTurn, frame: AgentEvent): AgentEvent | undefined => {
    if (frame.kind === "subagent" || frame.kind === "subagent_update") {
        return fileReportedSubagent(turn, frame);
    }
    // A subagent's calls carry the id of the call that started it, so its edits and checks attribute without a join.
    if (frame.kind === "tool_call") {
        noteChildWork(turn.conversations, frame, frame.parentToolUseId);
    } else if (frame.kind === "tool_call_update") {
        noteChildWork(turn.conversations, frame, undefined);
    }
    return frame;
};

/** A runtime's frames with the subagents it reports filed as they pass; its turn's end closes any still going. */
export async function* withRuntimeSubagents(frames: AsyncIterable<AgentEvent>, turn: SubagentTurn): AsyncGenerator<AgentEvent> {
    try {
        for await (const frame of frames) {
            const passed = filed(turn, frame);
            if (passed !== undefined) {
                yield passed;
            }
        }
        // Its subagents live and die with the runtime's turn: one it never ended is closed, and the transcript told.
        yield* closeSubagents(turn.conversations, turn.conversationId);
    } finally {
        // A turn cut short still closes them, with no transcript left to tell; after the lines above this finds none.
        closeSubagents(turn.conversations, turn.conversationId);
    }
}
