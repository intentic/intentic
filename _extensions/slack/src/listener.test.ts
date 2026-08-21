import { WORKSPACE_ROOT } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { SlackConnection } from "./client.js";
import type { GatewayCtx } from "@intentic/connector-runtime";
import { createSlackListener, type SlackEnvelope, type SlackMessage, toHistory, tsToIso } from "./listener.js";

const SELF = "U0BOT";

// The slice of a SlackConnection the listener touches. Everything not stubbed here would throw on use, which is
// the point: a test that starts needing more says so instead of silently passing.
const fakeConnection = (over: Record<string, unknown> = {}): SlackConnection =>
    ({
        selfUserId: SELF,
        socket: {} as SlackConnection["socket"],
        web: {
            users: { info: async () => ({ user: { profile: { display_name: "Ada" } } }) },
            reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
            conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) },
            chat: { postMessage: async () => ({ ts: "9.9" }), update: async () => ({ ok: true }) },
            ...over,
        },
    }) as unknown as SlackConnection;

const fakeCtx = (): { ctx: GatewayCtx; dispatched: object[]; streamed: object[] } => {
    const dispatched: object[] = [];
    const streamed: object[] = [];
    return {
        dispatched,
        streamed,
        ctx: {
            log: { info: () => {}, warn: () => {}, error: () => {} },
            workspaceRoot: WORKSPACE_ROOT,
            daemon: {
                state: async () => ({ automations: [], connectors: [] }),
                dispatch: async (message) => void dispatched.push(message),
                dispatchStreaming: async (message, onFrame) => {
                    streamed.push(message);
                    onFrame({ automationId: "a1", delta: "hi" });
                    onFrame({ automationId: "a1", end: true });
                },
                failure: async () => {},
                status: async () => {},
            },
        },
    };
};

const envelope = (event: object): SlackEnvelope => ({ ack: async () => {}, type: "events_api", body: { event: event as never, team_id: "T1" } });

const messageEvent = (over: Partial<SlackMessage> = {}): SlackMessage => ({
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "deploy is red again",
    ts: "1755102030.001900",
    ...over,
});

test("a Slack ts becomes the ISO timestamp the wire schema wants", () => {
    expect(tsToIso("1755102030.001900")).toBe("2025-08-13T16:20:30.001Z");
});

test("history is chronological whichever way Slack handed it over, and flags our own posts", () => {
    const raw: SlackMessage[] = [
        { user: "U1", text: "first", ts: "1.0" },
        { user: SELF, text: "second", ts: "2.0" },
    ];
    const byName = (m: SlackMessage): string => m.user ?? "?";
    // conversations.replies is oldest-first and stays as-is; conversations.history is newest-first and flips.
    expect(toHistory(raw, "oldest-first", new Set([SELF]), byName).map((e) => e.content)).toEqual(["first", "second"]);
    expect(toHistory(raw, "newest-first", new Set([SELF]), byName).map((e) => e.content)).toEqual(["second", "first"]);
    expect(toHistory(raw, "oldest-first", new Set([SELF]), byName).map((e) => e.self)).toEqual([undefined, true]);
});

test("a plain channel message dispatches without a mention and without holding a reply stream", async () => {
    const { ctx, dispatched, streamed } = fakeCtx();
    const connection = fakeConnection();
    createSlackListener(ctx, () => new Map([["app", connection]])).onEvent(connection, envelope(messageEvent()));
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(streamed).toEqual([]);
    expect(dispatched[0]).toMatchObject({
        provider: "slack",
        type: "message",
        channelId: "C1",
        author: { id: "U1", name: "Ada" },
        content: "deploy is red again",
        extra: { threadTs: "1755102030.001900", teamId: "T1" },
    });
    expect(dispatched[0]).not.toHaveProperty("mentioned");
});

test("an @mention holds the streaming dispatch and paints the reply into a thread", async () => {
    const { ctx, streamed } = fakeCtx();
    const posted: Array<{ channel: string; thread_ts: string; text: string }> = [];
    const connection = fakeConnection({
        chat: {
            postMessage: async (args: { channel: string; thread_ts: string; text: string }) => {
                posted.push(args);
                return { ts: "9.9" };
            },
            update: async () => ({ ok: true }),
        },
    });
    createSlackListener(ctx, () => new Map([["app", connection]])).onEvent(connection, envelope(messageEvent({ text: `<@${SELF}> help` })));
    await vi.waitFor(() => expect(streamed).toHaveLength(1));
    expect(streamed[0]).toMatchObject({ mentioned: true });
    // The reply threads under the message that asked for it rather than landing in the channel.
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ channel: "C1", thread_ts: "1755102030.001900", text: "hi" });
});

test("every message in a DM counts as addressed to us", async () => {
    const { ctx, streamed } = fakeCtx();
    const connection = fakeConnection();
    createSlackListener(ctx, () => new Map([["app", connection]])).onEvent(
        connection,
        envelope(messageEvent({ channel_type: "im", text: "no tag needed" })),
    );
    await vi.waitFor(() => expect(streamed).toHaveLength(1));
    expect(streamed[0]).toMatchObject({ mentioned: true });
});

test("a follow-up in a thread the bot already replied in needs no re-tag", async () => {
    const { ctx, streamed } = fakeCtx();
    const connection = fakeConnection({
        conversations: {
            history: async () => ({ messages: [] }),
            // The bot is in this thread, so the untagged follow-up is still for it.
            replies: async () => ({ messages: [{ user: SELF, text: "on it", ts: "1.0" }] }),
        },
    });
    createSlackListener(ctx, () => new Map([["app", connection]])).onEvent(
        connection,
        envelope(messageEvent({ thread_ts: "1.0", text: "and the other one?" })),
    );
    await vi.waitFor(() => expect(streamed).toHaveLength(1));
    expect(streamed[0]).toMatchObject({ mentioned: true, extra: { threadTs: "1.0" } });
});

test("our own posts never wake us, and neither does the same message delivered twice", async () => {
    const { ctx, dispatched } = fakeCtx();
    const connection = fakeConnection();
    const listener = createSlackListener(ctx, () => new Map([["app", connection]]));
    // The agent's own reply landing back in the channel.
    listener.onEvent(connection, envelope(messageEvent({ user: SELF, text: "done" })));
    // Slack's message + app_mention double delivery of one human message.
    listener.onEvent(connection, envelope(messageEvent({ id: "x" } as Partial<SlackMessage>)));
    listener.onEvent(connection, envelope({ ...messageEvent(), type: "app_mention" }));
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatched).toHaveLength(1);
});

test("channel bookkeeping (joins, edits, topic changes) never wakes an automation", async () => {
    const { ctx, dispatched } = fakeCtx();
    const connection = fakeConnection();
    const listener = createSlackListener(ctx, () => new Map([["app", connection]]));
    for (const subtype of ["channel_join", "message_changed", "channel_topic", "message_deleted"]) {
        listener.onEvent(connection, envelope(messageEvent({ subtype, ts: `${subtype}.0` })));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dispatched).toEqual([]);
});

test("a reaction dispatches with the message it points at as its content", async () => {
    const { ctx, dispatched } = fakeCtx();
    const connection = fakeConnection({
        conversations: {
            history: async () => ({ messages: [{ user: "U1", text: "please handle this", ts: "5.0" }] }),
            replies: async () => ({ messages: [] }),
        },
    });
    createSlackListener(ctx, () => new Map([["app", connection]])).onEvent(
        connection,
        envelope({
            type: "reaction_added",
            user: "U2",
            reaction: "robot_face",
            item: { type: "message", channel: "C1", ts: "5.0" },
            event_ts: "6.0",
        }),
    );
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]).toMatchObject({
        provider: "slack",
        type: "reaction_added",
        channelId: "C1",
        content: "please handle this",
        extra: { reaction: "robot_face", messageTs: "5.0" },
    });
});

test("every envelope is acked, including one we choose not to dispatch", async () => {
    const { ctx } = fakeCtx();
    const connection = fakeConnection();
    const acked: string[] = [];
    const listener = createSlackListener(ctx, () => new Map([["app", connection]]));
    const acking = (event: object, tag: string): SlackEnvelope => ({
        ack: async () => void acked.push(tag),
        type: "events_api",
        body: { event: event as never, team_id: "T1" },
    });
    // An unacked envelope is redelivered three times and then costs the app its socket, so a filtered event
    // has to be acked exactly as a dispatched one is.
    listener.onEvent(connection, acking(messageEvent({ subtype: "channel_join" }), "join"));
    listener.onEvent(connection, acking(messageEvent({ user: SELF }), "self"));
    await vi.waitFor(() => expect(acked).toEqual(["join", "self"]));
});
