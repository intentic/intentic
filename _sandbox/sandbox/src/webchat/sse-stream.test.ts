import type { SSEStreamingApi } from "hono/streaming";
import { expect, test } from "vitest";
import { createSseStream } from "./sse-stream.js";

// A fake SSEStreamingApi that records the frames written, in order.
const fakeStream = (frames: Array<{ event?: string; data: string }>): SSEStreamingApi =>
    ({ writeSSE: async (message: { event?: string; data: string }) => void frames.push(message) }) as unknown as SSEStreamingApi;

test("delta writes one delta frame per non-empty chunk; end writes a terminal done frame, in order", async () => {
    const frames: Array<{ event?: string; data: string }> = [];
    const stream = createSseStream(fakeStream(frames));
    stream.turn.delta("Hel");
    stream.turn.delta("");
    stream.turn.delta("lo");
    stream.turn.end();
    await stream.flushed();
    expect(frames).toEqual([
        { event: "delta", data: "Hel" },
        { event: "delta", data: "lo" },
        { event: "done", data: "" },
    ]);
});

/* The frame that did not exist, and the silence it left: a wake that errored closed the stream with `done`
 * alone, which the widget reads as "the agent had nothing to say" — indistinguishable from an empty reply. */
test("failed writes an error frame before the terminal done", async () => {
    const frames: Array<{ event?: string; data: string }> = [];
    const stream = createSseStream(fakeStream(frames));
    stream.turn.failed("API Error: 401 OAuth access token has been revoked");
    stream.turn.end();
    await stream.flushed();
    expect(frames.map((frame) => frame.event)).toEqual(["error", "done"]);
});

/* The reason is the OWNER's — their billing, their credentials, their guard script's stderr — and the audience
 * on this stream is an anonymous stranger on someone else's website. It must not cross. */
test("the visitor's error frame carries none of the provider's reason", async () => {
    const frames: Array<{ event?: string; data: string }> = [];
    const stream = createSseStream(fakeStream(frames));
    stream.turn.failed("Your organization has disabled Claude subscription access · account owner@example.com");
    await stream.flushed();
    const [error] = frames;
    expect(error?.data).toBe("Sorry — I couldn't answer that just now. Please try again in a moment.");
    expect(error?.data).not.toMatch(/organization|Claude|@/);
});

test("flushed() resolves only after every chained write completes", async () => {
    const written: string[] = [];
    // Each write resolves on a microtask, so an un-awaited flush would miss the tail.
    const slow = { writeSSE: async (m: { data: string }) => void (await Promise.resolve(), written.push(m.data)) } as unknown as SSEStreamingApi;
    const stream = createSseStream(slow);
    stream.turn.delta("a");
    stream.turn.delta("b");
    stream.turn.end();
    await stream.flushed();
    expect(written).toEqual(["a", "b", ""]);
});
