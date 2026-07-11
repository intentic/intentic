import { expect, test, vi } from "vitest";
import { createDiscordStream, type EditableMessage, type StreamChannel } from "./discord-stream.js";

// A fake channel: each send() records a message whose content later edits mutate, so `messages` always reflects
// what Discord would currently show.
const fakeChannel = (): { channel: StreamChannel; messages: { content: string }[] } => {
    const messages: { content: string }[] = [];
    const channel: StreamChannel = {
        send: async (content: string) => {
            const message = { content };
            messages.push(message);
            const editable: EditableMessage = {
                edit: async (next: string) => {
                    message.content = next;
                },
            };
            return editable;
        },
    };
    return { channel, messages };
};

test("streams deltas into one live message and flushes the final text on end", async () => {
    vi.useFakeTimers();
    const { channel, messages } = fakeChannel();
    const stream = createDiscordStream(channel, () => {});

    stream.delta("Hel");
    stream.delta("lo");
    // Nothing is posted until the rate-limit timer fires — a burst of tokens coalesces into one paint.
    expect(messages).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(messages.map((m) => m.content)).toEqual(["Hello"]);

    // Tokens after the last paint are flushed by end(), editing the same message.
    stream.delta(" there");
    stream.end();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(messages.map((m) => m.content)).toEqual(["Hello there"]);
    vi.useRealTimers();
});

test("spills past 2000 chars into follow-up messages, finalizing the full first message", async () => {
    vi.useFakeTimers();
    const { channel, messages } = fakeChannel();
    const stream = createDiscordStream(channel, () => {});

    stream.delta("a".repeat(2_000));
    stream.delta("b".repeat(500));
    stream.end();
    await vi.advanceTimersByTimeAsync(1_200);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe("a".repeat(2_000));
    expect(messages[1]?.content).toBe("b".repeat(500));
    vi.useRealTimers();
});

test("posts nothing when the turn produced no text", async () => {
    vi.useFakeTimers();
    const { channel, messages } = fakeChannel();
    const stream = createDiscordStream(channel, () => {});
    stream.end();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(messages).toEqual([]);
    vi.useRealTimers();
});

test("a send failure is reported via onError and never throws into the turn", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const channel: StreamChannel = {
        send: async () => {
            throw new Error("missing Send Messages permission");
        },
    };
    const stream = createDiscordStream(channel, (error) => errors.push(error));
    stream.delta("hi");
    stream.end();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(errors).toHaveLength(1);
    // A dead stream ignores further deltas rather than retrying the failing send.
    stream.delta("more");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(errors).toHaveLength(1);
    vi.useRealTimers();
});
