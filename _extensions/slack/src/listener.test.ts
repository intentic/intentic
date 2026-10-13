import { WORKSPACE_ROOT } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import type { SlackConnection } from "./client.js";
import { type GatewayCtx, type ListenerDispatchFrame, type ListenerStop, type ListenerStopAnswer, stopButtonId } from "@intentic/connector-runtime";
import { STATUS_BLOCK_ID } from "./card.js";
import { createSlackListener, type SlackEnvelope, type SlackMessage, toHistory, tsToIso, welcomeText } from "./listener.js";

const SELF = "U0BOT";

// The slice of a SlackConnection the listener touches. Everything not stubbed here would throw on use, which is
// the point: a test that starts needing more says so instead of silently passing.
const fakeConnection = (over: Record<string, unknown> = {}): SlackConnection =>
    ({
        appToken: "xapp-1",
        selfUserId: SELF,
        socket: {} as SlackConnection["socket"],
        web: {
            users: { info: async () => ({ user: { profile: { display_name: "Ada" } } }) },
            reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
            conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) },
            chat: { postMessage: async () => ({ ts: "9.9" }), update: async () => ({ ok: true }), postEphemeral: async () => ({ ok: true }) },
            assistant: { threads: { setStatus: async () => ({ ok: true }) } },
            ...over,
        },
    }) as unknown as SlackConnection;

// A quick answer: the turn opens, says "hi" and ends.
const QUICK_ANSWER: ListenerDispatchFrame[] = [
    { automationId: "a1", opened: { conversationId: "conv-1" } },
    { automationId: "a1", delta: "hi" },
    { automationId: "a1", end: true },
];

const fakeCtx = (
    frames: readonly ListenerDispatchFrame[] = QUICK_ANSWER,
    stopAnswer: ListenerStopAnswer = { stopped: true },
    // Holds each stream open after its frames until this settles: a turn still running.
    holding: Promise<void> = Promise.resolve(),
): { ctx: GatewayCtx; dispatched: object[]; streamed: object[]; stops: ListenerStop[] } => {
    const dispatched: object[] = [];
    const streamed: object[] = [];
    const stops: ListenerStop[] = [];
    return {
        dispatched,
        streamed,
        stops,
        ctx: {
            // The listener never reaches past its daemon client; any touch of the process api fails by name.
            api: unstubbed<GatewayCtx["api"]>("api", {}),
            log: { info: () => {}, warn: () => {}, error: () => {} },
            workspaceRoot: WORKSPACE_ROOT,
            daemon: {
                state: async () => ({ automations: [], connectors: [] }),
                dispatch: async (message) => void dispatched.push(message),
                dispatchStreaming: async (message, onFrame) => {
                    streamed.push(message);
                    for (const frame of frames) {
                        onFrame(frame);
                    }
                    await holding;
                },
                failure: async () => {},
                stop: async (stop) => {
                    stops.push(stop);
                    return stopAnswer;
                },
                status: async () => {},
                transcribe: async () => "",
                speak: async () => undefined,
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
    text: "deploy is failing again",
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
    await waitFor(() => expect(dispatched).toHaveLength(1));
    expect(streamed).toEqual([]);
    expect(dispatched[0]).toMatchObject({
        provider: "slack",
        type: "message",
        channelId: "C1",
        author: { id: "U1", name: "Ada" },
        content: "deploy is failing again",
        extra: { threadTs: "1755102030.001900", teamId: "T1" },
    });
    expect(dispatched[0]).not.toHaveProperty("mentioned");
    // A top-level message not for us belongs to the channel's conversation, not a thread's.
    expect(dispatched[0]).not.toHaveProperty("thread");
});

// A connection that records what it posted and which reactions it put on or took off, in order.
const recordingConnection = (over: Record<string, unknown> = {}) => {
    const posted: Array<{ channel: string; thread_ts?: string; text: string; blocks?: Array<{ type: string; text?: unknown; block_id?: string }> }> = [];
    const reactions: string[] = [];
    const ephemeral: Array<{ channel: string; user: string; text: string; thread_ts?: string }> = [];
    const connection = fakeConnection({
        chat: {
            postMessage: async (args: (typeof posted)[number]) => {
                posted.push(args);
                return { ts: `9.${posted.length}` };
            },
            update: async () => ({ ok: true }),
            postEphemeral: async (args: (typeof ephemeral)[number]) => {
                ephemeral.push(args);
                return { ok: true };
            },
        },
        reactions: {
            add: async ({ name }: { name: string }) => void reactions.push(`+${name}`),
            remove: async ({ name }: { name: string }) => void reactions.push(`-${name}`),
        },
        ...over,
    });
    return { connection, posted, reactions, ephemeral };
};

test("an @mention gets 👀 at once, its answer in the thread as Markdown, and ✅ when the turn ends", async () => {
    const { ctx, streamed } = fakeCtx();
    const { connection, posted, reactions } = recordingConnection();
    createSlackListener(ctx, () => new Map([["app", connection]])).onEvent(connection, envelope(messageEvent({ text: `<@${SELF}> help` })));
    await waitFor(() => expect(streamed).toHaveLength(1));
    // The thread the reply opens under the mention is the conversation's own.
    expect(streamed[0]).toMatchObject({ mentioned: true, thread: "1755102030.001900" });
    // The reply threads under the message that asked for it rather than landing in the channel, as a Markdown block.
    await waitFor(() => expect(reactions).toEqual(["+eyes", "+white_check_mark", "-eyes"]));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ channel: "C1", thread_ts: "1755102030.001900", text: "hi", blocks: [{ type: "markdown", text: "hi" }] });
});

test("a reply in a thread this process is answering is heard without a mention, before anything was posted there", async () => {
    // The first turn opens and never ends inside this test, so nothing has been posted in the thread yet.
    const { ctx, streamed } = fakeCtx([{ automationId: "a1", opened: { conversationId: "conv-1" } }]);
    const { connection } = recordingConnection();
    const listener = createSlackListener(ctx, () => new Map([["app", connection]]));
    listener.onEvent(connection, envelope(messageEvent({ text: `<@${SELF}> fix the login redirect` })));
    await waitFor(() => expect(streamed).toHaveLength(1));
    listener.onEvent(connection, envelope(messageEvent({ ts: "1755102031.000100", thread_ts: "1755102030.001900", user: "U2", text: "also the docs" })));
    await waitFor(() => expect(streamed).toHaveLength(2));
    expect(streamed[1]).toMatchObject({ mentioned: true, thread: "1755102030.001900" });
});

test("status cards are left out of the history the model reads, but still say the app answers in the thread", async () => {
    const { ctx, streamed } = fakeCtx();
    const card = { user: SELF, text: "✅ Done · 12s", ts: "1.1", blocks: [{ block_id: STATUS_BLOCK_ID }] };
    const { connection } = recordingConnection({
        conversations: {
            history: async () => ({ messages: [] }),
            replies: async () => ({ messages: [{ user: "U1", text: "<@U0BOT> look at this", ts: "1.0" }, card] }),
        },
    });
    createSlackListener(ctx, () => new Map([["app", connection]])).onEvent(connection, envelope(messageEvent({ thread_ts: "1.0", text: "thanks, one more" })));
    await waitFor(() => expect(streamed).toHaveLength(1));
    expect(streamed[0]).toMatchObject({ mentioned: true, history: [{ content: "<@U0BOT> look at this" }] });
});

test("Stop on a status card asks the daemon as the person who pressed it, and tells only them how it went", async () => {
    const { ctx, stops } = fakeCtx(QUICK_ANSWER, { stopped: false, reason: "Only the people this automation answers can stop it." });
    const { connection, ephemeral } = recordingConnection();
    const listener = createSlackListener(ctx, () => new Map([["app", connection]]));
    listener.onEvent(connection, {
        ack: async () => {},
        type: "interactive",
        body: {
            type: "block_actions",
            user: { id: "U7" },
            channel: { id: "C1" },
            message: { ts: "9.1", thread_ts: "1755102030.001900" },
            actions: [{ action_id: stopButtonId("conv-42") }],
        },
    });
    await waitFor(() => expect(ephemeral).toHaveLength(1));
    expect(stops).toEqual([{ conversationId: "conv-42", author: { id: "U7", name: "Ada" } }]);
    expect(ephemeral[0]).toEqual({ channel: "C1", user: "U7", thread_ts: "1755102030.001900", text: "Only the people this automation answers can stop it." });
});

test("invited into a channel, the app says hello there; someone else joining is no news", async () => {
    const { ctx } = fakeCtx();
    const { connection, posted } = recordingConnection();
    const listener = createSlackListener(ctx, () => new Map([["app", connection]]));
    listener.onEvent(connection, envelope({ type: "member_joined_channel", user: "U9", channel: "C2" }));
    listener.onEvent(connection, envelope({ type: "member_joined_channel", user: SELF, channel: "C3" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ channel: "C3", text: welcomeText(SELF) });
});

test("every message in a DM counts as addressed to us", async () => {
    const { ctx, streamed } = fakeCtx();
    const connection = fakeConnection();
    createSlackListener(ctx, () => new Map([["app", connection]])).onEvent(
        connection,
        envelope(messageEvent({ channel_type: "im", text: "no tag needed" })),
    );
    await waitFor(() => expect(streamed).toHaveLength(1));
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
    await waitFor(() => expect(streamed).toHaveLength(1));
    expect(streamed[0]).toMatchObject({ mentioned: true, thread: "1.0", extra: { threadTs: "1.0" } });
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
    await waitFor(() => expect(dispatched).toHaveLength(1));
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
    await waitFor(() => expect(dispatched).toHaveLength(1));
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
    await waitFor(() => expect(acked).toEqual(["join", "self"]));
});

test("⏹️ on a request whose turn is running stops it as the person who reacted, and wakes no automation", async () => {
    // The turn opens and its stream stays open, so it is still running when the reaction lands.
    let finish = (): void => {};
    const running = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const { ctx, stops, dispatched } = fakeCtx([{ automationId: "a1", opened: { conversationId: "conv-7" } }], { stopped: true }, running);
    const { connection, ephemeral } = recordingConnection();
    const listener = createSlackListener(ctx, () => new Map([["app", connection]]));
    listener.onEvent(connection, envelope(messageEvent({ text: `<@${SELF}> rebuild the docs` })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    listener.onEvent(
        connection,
        envelope({ type: "reaction_added", user: "U2", reaction: "black_square_for_stop", item: { type: "message", channel: "C1", ts: "1755102030.001900" }, event_ts: "9.0" }),
    );
    await waitFor(() => expect(stops).toEqual([{ conversationId: "conv-7", author: { id: "U2", name: "Ada" } }]));
    await waitFor(() => expect(ephemeral).toEqual([{ channel: "C1", user: "U2", thread_ts: "1755102030.001900", text: "Stopping it now." }]));
    expect(dispatched).toEqual([]);
    finish();
});
