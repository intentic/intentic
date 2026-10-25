import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { opt } from "../../../opt.js";

/* EVERY PROSE BLOCK CLOSED, WHICHEVER LOOP WROTE IT.

   `text_end` closes the block of `delta` frames a turn was writing (agent-events.ts): the chat retires its bubble there,
   a parent reads a child's report from the last block, and a turn that narrates between tool calls is several blocks,
   not one. Claude Code, Codex, Pi and Muse say where each block ends; ACP agents, Cursor and OpenCode stream deltas and
   move on. At the turn's one exit (stream-agent.ts) a block still open is closed by what the model does instead: a
   call, a thought, a plan, a question, a checklist or a subagent, each within its own subagent's thread. A loop that
   closed its own block is never closed twice, and the end of the turn needs no boundary of its own: every reader takes
   the block a turn ended in as its last (children.ts, where an unclosed bubble outranks the last closed one). */

type Frame = AgentEvent;

// What a model does instead of writing more of the same block.
const ENDS_PROSE: ReadonlySet<Frame["kind"]> = new Set(["tool_call", "thinking", "plan", "question", "todos", "subagent"]);

const threadOf = (frame: Frame): string => ("parentToolUseId" in frame ? (frame.parentToolUseId ?? "") : "");

const closing = (thread: string): Frame => ({ kind: "text_end", ...opt("parentToolUseId", thread === "" ? undefined : thread) });

/** `frames`, with a `text_end` before whatever ends a block its loop left open. */
export async function* withTextBoundaries(frames: AsyncIterable<Frame>): AsyncGenerator<Frame> {
    const open = new Set<string>();
    for await (const frame of frames) {
        const thread = threadOf(frame);
        if (frame.kind === "delta") {
            open.add(thread);
        } else if (frame.kind === "text_end") {
            open.delete(thread);
        } else if (ENDS_PROSE.has(frame.kind) && open.delete(thread)) {
            yield closing(thread);
        }
        yield frame;
    }
}
