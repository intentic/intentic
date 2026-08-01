import { expect, test, vi } from "vitest";
import { createSlackStream, type SlackPoster } from "./stream.js";

// A fake Slack channel that records what was posted and how each message ended up after its edits.
const fakePoster = (): { poster: SlackPoster; messages: string[]; posts: number; updates: number } => {
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
                return `ts-${messages.length}`;
            },
            update: async (ts, text) => {
                state.updates += 1;
                messages[Number(ts.slice(3)) - 1] = text;
            },
        },
    };
};

test("a short reply lands as one message, fully flushed on end", async () => {
    const fake = fakePoster();
    const painter = createSlackStream(fake.poster, () => {});
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
        const painter = createSlackStream(fake.poster, () => {});
        painter.delta("one");
        await vi.advanceTimersByTimeAsync(2_000);
        expect(fake.messages).toEqual(["one"]);
        painter.delta(" two");
        await vi.advanceTimersByTimeAsync(2_000);
        // Still one message — the reply GROWS rather than spamming the thread.
        expect(fake.messages).toEqual(["one two"]);
        expect(fake.posts).toBe(1);
        expect(fake.updates).toBeGreaterThanOrEqual(1);
    } finally {
        vi.useRealTimers();
    }
});

test("a reply past the character ceiling spills into follow-up messages, losing nothing", async () => {
    const fake = fakePoster();
    const painter = createSlackStream(fake.poster, () => {});
    const long = "x".repeat(9_000);
    painter.delta(long);
    painter.end();
    await vi.waitFor(() => expect(fake.messages.join("")).toBe(long));
    // 9000 chars at a 3800 ceiling = three messages, and the join above proves the split is lossless.
    expect(fake.messages).toHaveLength(3);
});

test("a failed post kills the stream and reports once instead of throwing into the turn", async () => {
    const errors: unknown[] = [];
    const painter = createSlackStream(
        { post: async () => Promise.reject(new Error("channel_not_found")), update: async () => undefined },
        (error) => errors.push(error),
    );
    painter.delta("hello");
    painter.end();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    // Dead means dead: later deltas are dropped rather than retrying a channel we can't post to.
    painter.delta("more");
    painter.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toHaveLength(1);
});
