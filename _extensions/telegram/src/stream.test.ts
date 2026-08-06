import { expect, test, vi } from "vitest";
import { createTelegramStream, type TelegramPoster } from "./stream.js";

// A fake Telegram chat that records what was sent and how each message ended up after its edits.
const fakePoster = (): { poster: TelegramPoster; messages: string[]; posts: number; updates: number } => {
    const messages: string[] = [];
    const state = { posts: 0, updates: 0 };
    return {
        messages,
        get posts() {
            return state.posts;
        },
        get updates() {
            return state.updates;
        },
        poster: {
            post: async (text) => {
                state.posts += 1;
                messages.push(text);
                return messages.length;
            },
            update: async (messageId, text) => {
                state.updates += 1;
                messages[messageId - 1] = text;
            },
        },
    };
};

test("a short reply lands as one message, fully flushed on end", async () => {
    const fake = fakePoster();
    const painter = createTelegramStream(fake.poster, () => {});
    painter.delta("Looking at ");
    painter.delta("the failing run…");
    painter.end();
    await vi.waitFor(() => expect(fake.messages).toEqual(["Looking at the failing run…"]));
    expect(fake.posts).toBe(1);
});

test("deltas arriving after the rate-limited first paint are edited into the same message", async () => {
    vi.useFakeTimers();
    try {
        const fake = fakePoster();
        const painter = createTelegramStream(fake.poster, () => {});
        painter.delta("one");
        await vi.advanceTimersByTimeAsync(3_000);
        expect(fake.messages).toEqual(["one"]);
        painter.delta(" two");
        await vi.advanceTimersByTimeAsync(3_000);
        // Still one message — the reply GROWS rather than spamming the chat.
        expect(fake.messages).toEqual(["one two"]);
        expect(fake.posts).toBe(1);
        expect(fake.updates).toBeGreaterThanOrEqual(1);
    } finally {
        vi.useRealTimers();
    }
});

test("a reply past the character ceiling spills into follow-up messages, losing nothing", async () => {
    const fake = fakePoster();
    const painter = createTelegramStream(fake.poster, () => {});
    const long = "x".repeat(9_000);
    painter.delta(long);
    painter.end();
    await vi.waitFor(() => expect(fake.messages.join("")).toBe(long));
    // 9000 chars at a 3900 ceiling = three messages, and the join above proves the split is lossless. Telegram
    // refuses anything over 4096 outright, so a message longer than one here would post NOTHING.
    expect(fake.messages).toHaveLength(3);
    expect(fake.messages.every((message) => message.length <= 4_096)).toBe(true);
});

test("a failed send kills the stream and reports once instead of throwing into the turn", async () => {
    const errors: unknown[] = [];
    const painter = createTelegramStream({ post: async () => Promise.reject(new Error("chat not found")), update: async () => undefined }, (error) =>
        errors.push(error),
    );
    painter.delta("hello");
    painter.end();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    // Dead means dead: later deltas are dropped rather than retrying a chat we can't post to.
    painter.delta("more");
    painter.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toHaveLength(1);
});
