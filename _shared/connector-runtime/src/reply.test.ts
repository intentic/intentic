import type { ListenerDispatchFrame, ListenerMessage } from "@intentic/sandbox-contract";
import { waitFor } from "@intentic/testing/bun";
import { GatewayRefusal } from "./gateway.js";
import { deliverChunked, paintReply } from "./reply.js";

const none = (): Error => new GatewayRefusal("nothing is connected");

test("a delivery is cut at the ceiling and sent in order through the first target that takes it", async () => {
    const sent: string[] = [];
    const results = await deliverChunked(["a"], async (target, chunk) => sent.push(`${target}:${chunk}`), "abcdefg", 3, none);
    expect(sent).toEqual(["a:abc", "a:def", "a:g"]);
    expect(results).toEqual([1, 2, 3]);
});

test("a target that fails before its first chunk is passed over for the next", async () => {
    const sent: string[] = [];
    await deliverChunked(
        ["down", "up"],
        async (target, chunk) => {
            if (target === "down") {
                throw new Error("cannot see the channel");
            }
            sent.push(chunk);
        },
        "hello",
        10,
        none,
    );
    expect(sent).toEqual(["hello"]);
});

test("a failure after a chunk landed is thrown rather than posting the spill twice through another target", async () => {
    const sent: string[] = [];
    const delivery = deliverChunked(
        ["first", "second"],
        async (target, chunk) => {
            if (target === "first" && sent.length === 1) {
                throw new Error("rate limited mid-spill");
            }
            sent.push(`${target}:${chunk}`);
        },
        "aabb",
        2,
        none,
    );
    await expect(delivery).rejects.toThrow("rate limited mid-spill");
    expect(sent).toEqual(["first:aa"]);
});

test("with no target the refusal is the answer, and with every target failing the last failure is", async () => {
    await expect(deliverChunked([], async () => undefined, "x", 10, none)).rejects.toThrow("nothing is connected");
    const failing = deliverChunked(
        ["a", "b"],
        async (target) => {
            throw new Error(`${target} refused`);
        },
        "x",
        10,
        none,
    );
    await expect(failing).rejects.toThrow("b refused");
});

const PAYLOAD: ListenerMessage = {
    provider: "test",
    type: "message",
    id: "1",
    channelId: "c",
    author: { id: "u", name: "U" },
    content: "hi",
    timestamp: "2026-01-01T00:00:00.000Z",
};

// A daemon whose streaming dispatch plays back the given frames, then ends.
const daemonPlaying = (frames: readonly ListenerDispatchFrame[]) => ({
    dispatchStreaming: async (_payload: ListenerMessage, onFrame: (frame: ListenerDispatchFrame) => void): Promise<void> => {
        for (const frame of frames) {
            onFrame(frame);
        }
    },
});

test("a buffered reply is sent whole at the end, and the indicator is retired once the stream is over", async () => {
    const sent: string[] = [];
    const settled: string[] = [];
    await paintReply(daemonPlaying([{ automationId: "a", delta: "Hel" }, { automationId: "a", delta: "lo" }, { automationId: "a", end: true }]), PAYLOAD, {
        surface: { send: async (text) => void sent.push(text) },
        maxChars: 100,
        onError: () => undefined,
        settle: () => void settled.push("typing stopped"),
    });
    await waitFor(() => sent.length === 1);
    expect(sent).toEqual(["Hello"]);
    expect(settled).toEqual(["typing stopped"]);
});

test("a failed turn says so in the chat, marked and clamped to the ceiling, posted outside the painter", async () => {
    const posted: string[] = [];
    await paintReply(daemonPlaying([{ automationId: "a", failed: "the model is out of credit" }]), PAYLOAD, {
        surface: { stream: { post: async (text) => posted.push(text), update: async () => undefined }, editIntervalMs: 10 },
        maxChars: 12,
        onError: () => undefined,
    });
    await waitFor(() => posted.length === 1);
    expect(posted).toEqual(["⚠️ the model"]);
});

test("the indicator is retired even when the stream breaks", async () => {
    const settled: string[] = [];
    const broken = {
        dispatchStreaming: async (): Promise<void> => {
            throw new Error("daemon went away");
        },
    };
    await expect(
        paintReply(broken, PAYLOAD, { surface: { send: async () => undefined }, maxChars: 10, onError: () => undefined, settle: () => void settled.push("done") }),
    ).rejects.toThrow("daemon went away");
    expect(settled).toEqual(["done"]);
});
