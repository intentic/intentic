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
