import type { SSEStreamingApi } from "hono/streaming";
import type { TurnStream } from "../automations/scheduler.js";

export interface SseTurnStream {
    readonly turn: TurnStream;
    // Resolves once every queued frame (the deltas and the terminal `done`) has been written, so the route can
    // await it before letting streamSSE close the connection, otherwise a tail delta races the close and is lost.
    readonly flushed: () => Promise<void>;
}

/* What a VISITOR is told when the wake produces no reply. Deliberately one sentence for every cause.
 *
 * The reasons are real and specific, "OAuth access token has been revoked", "your organization has disabled
 * Claude subscription access", the tail of a guard script's stderr, and every one of them is a fact about the
 * OWNER's billing, credentials or scripts. The audience here is an anonymous stranger on someone else's
 * website, so none of it may cross: the widget says that the answer failed, and the owner reads why on the
 * automation's row and in the activity feed, which is where they can act on it. */
const VISITOR_FAILURE = "Sorry — I couldn't answer that just now. Please try again in a moment.";

// A TurnStream that forwards the agent's text to a web-chat widget as SSE frames, the SSE analogue of the
// connector runtime's streaming painter. No rate-limited repaint (SSE appends rather than edits): each delta is one `delta` frame,
// failed() emits an `error` frame and end() emits a terminal `done` frame. writeSSE is async, so frames are
// chained on a serial tail to keep their order; a write failure (the widget vanished) is swallowed so a dropped
// client never crashes the turn.
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
            // The reason is dropped on purpose, see VISITOR_FAILURE. It is not lost: the caller recorded it on
            // the run and in the activity feed before calling this.
            failed: () => write("error", VISITOR_FAILURE),
            end: () => write("done", ""),
        },
        // Loop until stable: a write chained during the await (none happen after end(), but cheap insurance) is
        // still flushed before we resolve.
        flushed: async () => {
            let prev: Promise<unknown>;
            do {
                prev = tail;
                await prev;
            } while (tail !== prev);
        },
    };
};
