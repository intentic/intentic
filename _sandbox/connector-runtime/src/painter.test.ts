import { expect, test, vi } from "vitest";
import { createBufferedPainter, createStreamingPainter, framePainter, type Painter, type StreamPoster } from "./painter.js";

// One suite for the machine that used to be tested four times, once per connector, against four identical
// fakes. Slack's tuning (3800/1500ms) stands in for all of them — the constants are parameters now, and the
// per-connector poster adapters are thin enough that their listeners' own tests cover the wiring.
const TUNING = { maxChars: 3_800, editIntervalMs: 1_500 };

// A fake channel that records what was posted and how each message ended up after its edits.
const fakePoster = (): { poster: StreamPoster<string>; messages: string[]; posts: number; updates: number } => {
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
    const painter = createStreamingPainter(fake.poster, () => {}, TUNING);
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
        const painter = createStreamingPainter(fake.poster, () => {}, TUNING);
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
    const painter = createStreamingPainter(fake.poster, () => {}, TUNING);
    const long = "x".repeat(9_000);
    painter.delta(long);
    painter.end();
    await vi.waitFor(() => expect(fake.messages.join("")).toBe(long));
    // 9000 chars at a 3800 ceiling = three messages, and the join above proves the split is lossless.
    expect(fake.messages).toHaveLength(3);
});

test("a failed post kills the stream and reports once instead of throwing into the turn", async () => {
    const errors: unknown[] = [];
    const painter = createStreamingPainter(
        { post: async () => Promise.reject(new Error("channel_not_found")), update: async () => undefined },
        (error) => errors.push(error),
        TUNING,
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

test("the buffered painter sends nothing until end, then everything once", async () => {
    const sent: string[] = [];
    const painter = createBufferedPainter(
        async (text) => {
            sent.push(text);
        },
        () => {},
        60_000,
    );
    painter.delta("first ");
    painter.delta("second");
    expect(sent).toEqual([]);
    painter.end();
    await vi.waitFor(() => expect(sent).toEqual(["first second"]));
    // end() is terminal: a late delta or second end must not double-send.
    painter.delta(" late");
    painter.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual(["first second"]);
});

test("framePainter routes deltas to one painter per automation and surfaces failures", async () => {
    const made: string[] = [];
    const painters = new Map<string, { deltas: string[]; ended: boolean }>();
    const failures: string[] = [];
    const paint = framePainter(
        (automationId) => {
            made.push(automationId);
            const record = { deltas: [] as string[], ended: false };
            painters.set(automationId, record);
            const painter: Painter = { delta: (text) => record.deltas.push(text), end: () => (record.ended = true) };
            return painter;
        },
        (reason) => failures.push(reason),
    );
    paint({ automationId: "a", delta: "one" });
    paint({ automationId: "b", delta: "two" });
    paint({ automationId: "a", delta: " more" });
    paint({ automationId: "a", failed: "usage limit reached" });
    paint({ automationId: "a", end: true });
    // One painter per automation, reused across frames — two automations answering one mention don't share.
    expect(made).toEqual(["a", "b"]);
    expect(painters.get("a")).toEqual({ deltas: ["one", " more"], ended: true });
    expect(painters.get("b")).toEqual({ deltas: ["two"], ended: false });
    expect(failures).toEqual(["usage limit reached"]);
});
