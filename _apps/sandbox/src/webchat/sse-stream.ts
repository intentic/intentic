import type { SSEStreamingApi } from "hono/streaming";
import type { TurnStream } from "../automations/scheduler.js";

export interface SseTurnStream {
    readonly turn: TurnStream;
    // Resolves once every queued frame (the deltas and the terminal `done`) has been written, so the route can
    // await it before letting streamSSE close the connection — otherwise a tail delta races the close and is lost.
    readonly flushed: () => Promise<void>;
}

// A TurnStream that forwards the agent's text to a web-chat widget as SSE frames — the SSE analogue of
// createDiscordStream. No rate-limited repaint (SSE appends rather than edits): each delta is one `delta` frame
// and end() emits a terminal `done` frame. writeSSE is async, so frames are chained on a serial tail to keep
// their order; a write failure (the widget vanished) is swallowed so a dropped client never crashes the turn.
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
