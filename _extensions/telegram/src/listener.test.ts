import { WORKSPACE_ROOT } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { TelegramConnection, TelegramMessage } from "./client.js";
import type { GatewayCtx } from "@intentic/connector-runtime";
import { addressesUs, attachmentsOf, authorNameOf, contentOf, createTelegramListener } from "./listener.js";

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
            log: { info: () => {}, warn: () => {}, error: () => {} },
            workspaceRoot: WORKSPACE_ROOT,
            daemon: {
                state: async () => ({ automations: [], connectors: [] }),
                dispatch: async (message) => void dispatched.push(message as Record<string, unknown>),
                dispatchStreaming: async (message, onFrame) => {
                    streamed.push(message as Record<string, unknown>);
                    onFrame({ automationId: "a1", delta: "on it" });
                    onFrame({ automationId: "a1", end: true });
                },
                failure: async () => {},
                status: async () => {},
            },
        },
    };
};

// The three fields Telegram always sends. Cases that are ABOUT an absent field — a photo with no caption, an
// anonymous channel post — build up from here rather than clearing one off a fuller message, because
// exactOptionalPropertyTypes has no way to spell "clear this".
const bare = (over: Partial<TelegramMessage> = {}): TelegramMessage => ({
    message_id: 11,
    chat: { id: -100123, type: "supergroup", title: "eng" },
    date: 1_755_102_030,
    ...over,
});

const message = (over: Partial<TelegramMessage> = {}): TelegramMessage =>
    bare({ from: { id: 42, first_name: "Ada", last_name: "Lovelace" }, text: "deploy is red again", ...over });

test("a media-only message says what it is instead of arriving empty", () => {
    expect(contentOf(bare({ voice: { file_id: "v1", duration: 12 } }))).toBe("[voice note, 12s]");
    expect(contentOf(bare({ document: { file_id: "d1", file_name: "trace.log" } }))).toBe("[file: trace.log]");
    // A caption is what the person actually wrote, so it wins over any marker.
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
    // An anonymous channel post has no author at all.
    expect(authorNameOf(bare({ chat: { id: -1, type: "channel", title: "releases" } }))).toBe("releases");
});

test("a message addresses us when it names the bot or replies to it — and not otherwise", () => {
    const usernames = new Set([SELF_NAME]);
    const selfIds = new Set([SELF_ID]);
    expect(addressesUs(message(), usernames, selfIds)).toBe(false);
    expect(addressesUs(message({ text: `hey @${SELF_NAME} look` }), usernames, selfIds)).toBe(true);
    // Telegram preserves the case a person typed; the bot is the same bot either way.
    expect(addressesUs(message({ text: "hey @ACME_Intentic_Bot" }), usernames, selfIds)).toBe(true);
    // The command form of a mention, which is how a group disambiguates two bots.
    expect(addressesUs(message({ text: `/status@${SELF_NAME}` }), usernames, selfIds)).toBe(true);
    expect(addressesUs(message({ reply_to_message: message({ from: { id: SELF_ID, is_bot: true } }) }), usernames, selfIds)).toBe(true);
    // A reply to somebody else is not a reply to us.
    expect(addressesUs(message({ reply_to_message: message({ from: { id: 9, first_name: "Bo" } }) }), usernames, selfIds)).toBe(false);
});

test("an unaddressed group message dispatches without holding a turn stream", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", fakeConnection(calls)]]));
    listener.onUpdate(fakeConnection(calls), { update_id: 1, message: message() });
    await vi.waitFor(() => expect(fake.dispatched).toHaveLength(1));
    expect(fake.streamed).toHaveLength(0);
    expect(fake.dispatched[0]).toMatchObject({ provider: "telegram", type: "message", channelId: "-100123", content: "deploy is red again" });
    expect(fake.dispatched[0]?.["mentioned"]).toBeUndefined();
    // Nothing is painted back, so the chat sees no typing indicator either.
    expect(calls).toEqual([]);
});

test("a private message is always addressed to us: it shows typing and streams the reply back", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", connection]]));
    listener.onUpdate(connection, { update_id: 1, message: message({ chat: { id: 42, type: "private" }, text: "hello?" }) });
    await vi.waitFor(() => expect(calls.map((call) => call.method)).toEqual(["sendChatAction", "sendMessage"]));
    expect(fake.streamed[0]).toMatchObject({ mentioned: true, channelId: "42" });
    expect(calls[1]?.body).toMatchObject({ chat_id: 42, text: "on it" });
    // A one-to-one chat has nothing to disambiguate, so the reply is not marked as a reply to anything.
    expect(calls[1]?.body).not.toHaveProperty("reply_parameters");
    listener.stopAll();
});

test("a group reply points at the message it answers, and stays in its forum topic", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["token", connection]]));
    listener.onUpdate(connection, { update_id: 1, message: message({ text: `@${SELF_NAME} status?`, message_thread_id: 5 }) });
    await vi.waitFor(() => expect(calls.some((call) => call.method === "sendMessage")).toBe(true));
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.body).toMatchObject({ chat_id: -100123, message_thread_id: 5, reply_parameters: { message_id: 11 } });
    listener.stopAll();
});

test("the same message reaching two of our bots wakes an agent once", async () => {
    const calls: { method: string; body: object }[] = [];
    const fake = fakeCtx();
    const first = fakeConnection(calls);
    const second = fakeConnection(calls);
    const listener = createTelegramListener(fake.ctx, () => new Map([["a", first]]));
    listener.onUpdate(first, { update_id: 1, message: message() });
    listener.onUpdate(second, { update_id: 2, message: message() });
    await vi.waitFor(() => expect(fake.dispatched).toHaveLength(1));
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
    await vi.waitFor(() => expect(fake.dispatched).toHaveLength(1));
    listener.onUpdate(connection, { update_id: 2, message: message({ message_id: 2, text: `@${SELF_NAME} what happened?` }) });
    await vi.waitFor(() => expect(fake.streamed).toHaveLength(1));
    // A bot cannot read a chat's past, so this ring is the only context there is — and it holds what came
    // BEFORE this message, not the message itself.
    expect(fake.streamed[0]?.["history"]).toEqual([
        { author: { id: "42", name: "Ada Lovelace" }, content: "the deploy went out at four", timestamp: "2025-08-13T16:20:30.000Z" },
    ]);
    listener.stopAll();
});
