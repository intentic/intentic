import type { SSEStreamingApi } from "hono/streaming";
import type { TurnStream } from "../automations/scheduler.js";

export interface SseTurnStream {
    readonly turn: TurnStream;
    // Resolves once every queued frame is written; await it before closing, or a tail delta is lost.
    readonly flushed: () => Promise<void>;
}

// One sentence for every cause; real reasons are the owner's own facts, not the visitor's.
const VISITOR_FAILURE = "Sorry: I couldn't answer that just now. Please try again in a moment.";

// Forwards the agent's text as SSE frames: `delta` per chunk, `error` on failure, `done` on end. Writes chain on a
// serial tail to keep order; a failed write is swallowed so a dropped client never crashes the turn.
export const createSseStream = (stream: SSEStreamingApi): SseTurnStream => {
    let tail: Promise<unknown> = Promise.resolve();
    const write = (event: string, data: string): void => {
        tail = tail.then(() => stream.writeSSE({ event, data })).catch(() => {});
    };
    return {
        turn: {
            delta: (text) => {
                if (text !== "") {
                    write("delta", text);
                }
            },
            // The reason is dropped on purpose (VISITOR_FAILURE); already recorded on the run and the activity feed.
            failed: () => write("error", VISITOR_FAILURE),
            end: () => write("done", ""),
        },
        // Loops until stable, so a write chained during the await is still flushed before resolving.
        flushed: async () => {
            let prev: Promise<unknown>;
            do {
                prev = tail;
                await prev;
            } while (tail !== prev);
        },
    };
};
