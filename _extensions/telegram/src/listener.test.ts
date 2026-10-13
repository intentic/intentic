import { WORKSPACE_ROOT } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import type { TelegramConnection, TelegramMessage } from "./client.js";
import type { GatewayCtx } from "@intentic/connector-runtime";
import { addressesUs, attachmentsOf, authorNameOf, contentOf, createTelegramListener, welcomeText } from "./listener.js";
import { REACTIONS } from "./reply.js";

const SELF_ID = 777;
const SELF_NAME = "acme_intentic_bot";

// The slice of a TelegramConnection the listener touches, recording every Bot API call it makes.
const fakeConnection = (calls: { method: string; body: object }[]): TelegramConnection => ({
    botToken: "token",
    selfId: SELF_ID,
    username: SELF_NAME,
    listen: () => {},
    call: async <T>(method: string, body?: object): Promise<T> => {
        calls.push({ method, body: body ?? {} });
        return { message_id: calls.length } as T;
    },
});

const fakeCtx = (): { ctx: GatewayCtx; dispatched: Record<string, unknown>[]; streamed: Record<string, unknown>[] } => {
    const dispatched: Record<string, unknown>[] = [];
    const streamed: Record<string, unknown>[] = [];
    return {
        dispatched,
        streamed,
        ctx: {
            // The listener never reaches past its daemon client; any touch of the process api fails by name.
            api: unstubbed<GatewayCtx["api"]>("api", {}),
            log: { info: () => {}, warn: () => {}, error: () => {} },
            workspaceRoot: WORKSPACE_ROOT,
            daemon: {
                state: async () => ({ automations: [], connectors: [] }),
                dispatch: async (message) => void dispatched.push(message as Record<string, unknown>),
                dispatchStreaming: async (message, onFrame) => {
                    streamed.push(message as Record<string, unknown>);
                    onFrame({ automationId: "a1", opened: { conversationId: "conv-1" } });
                    onFrame({ automationId: "a1", delta: "on it" });
                    onFrame({ automationId: "a1", end: true });
                },
                failure: async () => {},
                stop: async () => ({ stopped: false }),
                status: async () => {},
                transcribe: async () => "",
                speak: async () => undefined,
            },
        },
    };
};

// Telegram's three always-sent fields; built up from here since exactOptionalPropertyTypes can't spell "unset".
const bare = (over: Partial<TelegramMessage> = {}): TelegramMessage => ({
    message_id: 11,
    chat: { id: -100123, type: "supergroup", title: "eng" },
    date: 1_755_102_030,
    ...over,
});

const message = (over: Partial<TelegramMessage> = {}): TelegramMessage =>
    bare({ from: { id: 42, first_name: "Ada", last_name: "Lovelace" }, text: "deploy is failing again", ...over });

test("a media-only message says what it is instead of arriving empty", () => {
    expect(contentOf(bare({ voice: { file_id: "v1", duration: 12 } }))).toBe("[voice note, 12s]");
    expect(contentOf(bare({ document: { file_id: "d1", file_name: "trace.log" } }))).toBe("[file: trace.log]");
    expect(contentOf(bare({ caption: "look at this", photo: [{ file_id: "p1" }] }))).toBe("look at this");
});

test("the biggest photo size is the one worth fetching", () => {
    const sizes = [
        { file_id: "thumb", file_size: 900 },
        { file_id: "full", file_size: 90_000 },
    ];
    expect(attachmentsOf(message({ photo: sizes }))).toEqual([{ name: "photo", fileId: "full" }]);
});

test("the author is whatever Telegram gave us to call them", () => {
    expect(authorNameOf(message())).toBe("Ada Lovelace");
    expect(authorNameOf(message({ from: { id: 42, username: "ada" } }))).toBe("ada");
    // Anonymous channel post: no `from` at all.
    expect(authorNameOf(bare({ chat: { id: -1, type: "channel", title: "releases" } }))).toBe("releases");
});

test("a message addresses us when it names the bot or replies to it, and not otherwise", () => {
    const usernames = new Set([SELF_NAME]);
    const selfIds = new Set([SELF_ID]);
    expect(addressesUs(message(), usernames, selfIds)).toBe(false);
    expect(addressesUs(message({ text: `hey @${SELF_NAME} look` }), usernames, selfIds)).toBe(true);
    // Telegram preserves typed case; matching must be case-insensitive.
    expect(addressesUs(message({ text: "hey @ACME_Intentic_Bot" }), usernames, selfIds)).toBe(true);
    // `/status@bot` is the command form of a mention, used to disambiguate two bots in a group.
    expect(addressesUs(message({ text: `/status@${SELF_NAME}` }), usernames, selfIds)).toBe(true);
    expect(addressesUs(message({ reply_to_message: message({ from: { id: SELF_ID, is_bot: true } }) }), usernames, selfIds)).toBe(true);
    expect(addressesUs(message({ reply_to_message: message({ from: { id: 9, first_name: "Bo" } }) }), usernames, selfIds)).toBe(false);
});

test("an unaddressed group message dispatches without holding a turn stream", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", fakeConnection(calls)]]));
    listener.onUpdate(fakeConnection(calls), { update_id: 1, message: message() });
    await waitFor(() => expect(fake.dispatched).toHaveLength(1));
    expect(fake.streamed).toHaveLength(0);
    expect(fake.dispatched[0]).toMatchObject({ provider: "telegram", type: "message", channelId: "-100123", content: "deploy is failing again" });
    expect(fake.dispatched[0]?.["mentioned"]).toBeUndefined();
    // No reply painted, so no typing indicator either.
    expect(calls).toEqual([]);
});

test("a private message is always addressed to us: typing, 👀, the answer, then 👌", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", connection]]));
    listener.onUpdate(connection, { update_id: 1, message: message({ chat: { id: 42, type: "private" }, text: "hello?" }) });
    await waitFor(() => expect(calls.map((call) => call.method)).toEqual(["sendChatAction", "setMessageReaction", "sendMessage", "setMessageReaction"]));
    expect(fake.streamed[0]).toMatchObject({ mentioned: true, channelId: "42" });
    // A private chat is one conversation: no thread.
    expect(fake.streamed[0]).not.toHaveProperty("thread");
    expect(calls[2]?.body).toMatchObject({ chat_id: 42, text: "on it", parse_mode: "HTML" });
    // Private chat has nothing to disambiguate, so no `reply_parameters`.
    expect(calls[2]?.body).not.toHaveProperty("reply_parameters");
    expect(calls.filter((call) => call.method === "setMessageReaction").map((call) => call.body)).toEqual([
        { chat_id: 42, message_id: 11, reaction: [{ type: "emoji", emoji: REACTIONS.heard }] },
        { chat_id: 42, message_id: 11, reaction: [{ type: "emoji", emoji: REACTIONS.done }] },
    ]);
});

test("a group reply points at the message it answers, and stays in its forum topic", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", connection]]));
    listener.onUpdate(connection, { update_id: 1, message: message({ text: `@${SELF_NAME} status?`, message_thread_id: 5, is_topic_message: true }) });
    await waitFor(() => expect(calls.some((call) => call.method === "sendMessage")).toBe(true));
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.body).toMatchObject({ chat_id: -100123, message_thread_id: 5, reply_parameters: { message_id: 11 } });
    // The request's reply chain is its conversation, kept in its topic.
    expect(fake.streamed[0]).toMatchObject({ mentioned: true, thread: "5/11" });
});

test("the same message reaching two of our bots wakes an agent once", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const first = fakeConnection(calls);
    const second = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["a", first]]));
    listener.onUpdate(first, { update_id: 1, message: message() });
    listener.onUpdate(second, { update_id: 2, message: message() });
    await waitFor(() => expect(fake.dispatched).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.dispatched).toHaveLength(1);
});

test("our own message never wakes us", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", connection]]));
    listener.onUpdate(connection, { update_id: 1, message: message({ from: { id: SELF_ID, is_bot: true }, text: "on it" }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.dispatched).toHaveLength(0);
    expect(fake.streamed).toHaveLength(0);
});

test("what the gateway watched go by becomes the history a later mention carries", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", connection]]));
    listener.onUpdate(connection, { update_id: 1, message: message({ message_id: 1, text: "the deploy went out at four" }) });
    await waitFor(() => expect(fake.dispatched).toHaveLength(1));
    listener.onUpdate(connection, { update_id: 2, message: message({ message_id: 2, text: `@${SELF_NAME} what happened?` }) });
    await waitFor(() => expect(fake.streamed).toHaveLength(1));
    // History is only what the gateway saw before; a bot can't read the past, and it excludes this message itself.
    expect(fake.streamed[0]?.["history"]).toEqual([
        { author: { id: "42", name: "Ada Lovelace" }, content: "the deploy went out at four", timestamp: "2025-08-13T16:20:30.000Z" },
    ]);
});

// Telegram never hands a bot its own messages as updates, so the ring would otherwise hold only the other side of the
// conversation; Discord's and Slack's history APIs and WhatsApp's store all carry our replies, marked `self`.
test("our painted reply is in the history the next mention carries, marked as ours", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", connection]]));
    listener.onUpdate(connection, { update_id: 1, message: message({ message_id: 1, text: `@${SELF_NAME} status?` }) });
    await waitFor(() => expect(calls.some((call) => call.method === "sendMessage")).toBe(true));
    listener.onUpdate(connection, { update_id: 2, message: message({ message_id: 2, text: `@${SELF_NAME} and now?` }) });
    await waitFor(() => expect(fake.streamed).toHaveLength(2));
    expect(fake.streamed[1]?.["history"]).toEqual([
        { author: { id: "42", name: "Ada Lovelace" }, content: `@${SELF_NAME} status?`, timestamp: "2025-08-13T16:20:30.000Z" },
        { author: { id: String(SELF_ID), name: SELF_NAME }, content: "on it", timestamp: expect.any(String), self: true },
    ]);
});

test("a message the daemon delivers between turns is history too, one entry per message it took", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", connection]]));
    await listener.deliver("-100123", `${"x".repeat(4_096)  }tail`);
    const html = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };
    expect(calls.map((call) => call.body)).toEqual([
        { chat_id: "-100123", text: "x".repeat(4_096), ...html },
        { chat_id: "-100123", text: "tail", ...html },
    ]);
    listener.onUpdate(connection, { update_id: 1, message: message({ message_id: 3, text: `@${SELF_NAME} did that land?` }) });
    await waitFor(() => expect(fake.streamed).toHaveLength(1));
    const ours = { author: { id: String(SELF_ID), name: SELF_NAME }, timestamp: expect.any(String), self: true };
    expect(fake.streamed[0]?.["history"]).toEqual([
        { ...ours, content: "x".repeat(4_096) },
        { ...ours, content: "tail" },
    ]);
});

test("with no bot connected a delivery is refused in words the owner can act on", async () => {
    const listener = createTelegramListener(fakeCtx().ctx, () => new Map());
    await expect(listener.deliver("1", "hi")).rejects.toThrow("no Telegram bot is connected");
});

test("a reply in a request's chain is heard without a mention, and continues its conversation", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", connection]]));
    listener.onUpdate(connection, { update_id: 1, message: message({ message_id: 20, text: `@${SELF_NAME} fix the login redirect` }) });
    await waitFor(() => expect(fake.streamed).toHaveLength(1));
    expect(fake.streamed[0]).toMatchObject({ thread: "20" });
    // A teammate replies to the asker's message, with no mention.
    listener.onUpdate(connection, {
        update_id: 2,
        message: message({ message_id: 21, from: { id: 43, first_name: "Bo" }, text: "also the docs", reply_to_message: bare({ message_id: 20 }) }),
    });
    await waitFor(() => expect(fake.streamed).toHaveLength(2));
    expect(fake.streamed[1]).toMatchObject({ mentioned: true, thread: "20" });
    // A reply to the bot's own answer lands in the same chain too.
    // The fake answers each call with its position as the message id.
    await waitFor(() => expect(calls.some((call) => call.method === "sendMessage")).toBe(true));
    const answerId = calls.findIndex((call) => call.method === "sendMessage") + 1;
    listener.onUpdate(connection, {
        update_id: 3,
        message: message({ message_id: 22, text: "thanks!", reply_to_message: bare({ message_id: answerId, from: { id: SELF_ID, is_bot: true } }) }),
    });
    await waitFor(() => expect(fake.streamed).toHaveLength(3));
    expect(fake.streamed[2]).toMatchObject({ thread: "20" });
});

test("a Stop press asks the daemon as the person who pressed it, and answers only them", async () => {
    const calls: { method: string; body: object }[] = [];
    const stops: object[] = [];
    const fake = fakeCtx();
    const stop = async (asked: object) => {
        stops.push(asked);
        return { stopped: true };
    };
    const ctx = { ...fake.ctx, daemon: { ...fake.ctx.daemon, stop } };
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(ctx, () => new Map([["token", connection]]));
    listener.onUpdate(connection, { update_id: 1, callback_query: { id: "q1", from: { id: 42, first_name: "Ada" }, data: "stop:zz" } });
    await waitFor(() => expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]));
    // A token this process never handed out: that card's work is long over.
    expect(calls[0]?.body).toEqual({ callback_query_id: "q1", text: "That one has already finished." });
    expect(stops).toEqual([]);
});

test("added to a group, the bot says hello there; a private chat or someone else joining is no news", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", connection]]));
    const added = (chat: { id: number; type: string }, userId: number) => ({
        update_id: 1,
        my_chat_member: { chat, old_chat_member: { status: "left" }, new_chat_member: { status: "member", user: { id: userId } } },
    });
    listener.onUpdate(connection, added({ id: 5, type: "private" }, SELF_ID));
    listener.onUpdate(connection, added({ id: -100999, type: "supergroup" }, 9));
    listener.onUpdate(connection, added({ id: -100123, type: "supergroup" }, SELF_ID));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ method: "sendMessage", body: { chat_id: -100123, text: welcomeText(SELF_NAME) } });
});
