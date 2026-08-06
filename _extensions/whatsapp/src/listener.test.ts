import { expect, test, vi } from "vitest";
import type { WhatsAppConnection } from "./client.js";
import type { GatewayCtx } from "./context.js";
import { addressesUs, contentOf, createWhatsAppListener, hasMedia, jidUser, timestampOf, unwrap } from "./listener.js";
import type { WaMessageContent, WaRawMessage } from "./types.js";

const SELF = "4915100000001";
const SELF_LID = "123456789";
const GROUP = "1203630000000000@g.us";

// The slice of a WhatsAppConnection the listener touches, recording every call it makes.
const fakeConnection = (calls: { method: string; args: unknown[] }[]): WhatsAppConnection => ({
    capabilityId: "whatsapp-1",
    selfJid: () => `${SELF}@s.whatsapp.net`,
    selfLid: () => `${SELF_LID}@lid`,
    phase: () => "ready",
    pairingCode: () => undefined,
    sendText: async (...args) => void calls.push({ method: "sendText", args }),
    sendFile: async (...args) => void calls.push({ method: "sendFile", args }),
    presence: async (...args) => void calls.push({ method: "presence", args }),
    listChats: async () => [],
    download: async () => undefined,
});

const fakeCtx = (): { ctx: GatewayCtx; dispatched: Record<string, unknown>[]; streamed: Record<string, unknown>[] } => {
    const dispatched: Record<string, unknown>[] = [];
    const streamed: Record<string, unknown>[] = [];
    return {
        dispatched,
        streamed,
        ctx: {
            log: { info: () => {}, warn: () => {}, error: () => {} },
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

const groupMessage = (over: Partial<WaRawMessage> = {}, content: WaMessageContent = { conversation: "deploy is red again" }): WaRawMessage => ({
    key: { id: "MSG1", remoteJid: GROUP, fromMe: false, participant: "4915222222222@s.whatsapp.net" },
    pushName: "Ada",
    messageTimestamp: 1_755_102_030,
    message: content,
    ...over,
});

test("envelopes unwrap to the real content, however deeply WhatsApp nested them", () => {
    const inner: WaMessageContent = { conversation: "hi" };
    expect(unwrap({ ephemeralMessage: { message: { viewOnceMessageV2: { message: inner } } } })).toEqual(inner);
    expect(unwrap(inner)).toEqual(inner);
    expect(unwrap(undefined)).toBeUndefined();
});

test("a jid's user half survives device suffixes and either domain", () => {
    expect(jidUser("4915112345678@s.whatsapp.net")).toBe("4915112345678");
    expect(jidUser("4915112345678:17@s.whatsapp.net")).toBe("4915112345678");
    expect(jidUser("123456789@lid")).toBe("123456789");
    expect(jidUser(undefined)).toBe("");
});

test("a media-only message says what it is instead of arriving empty", () => {
    expect(contentOf({ audioMessage: { ptt: true, seconds: 12 } })).toBe("[voice note, 12s]");
    expect(contentOf({ documentMessage: { fileName: "trace.log" } })).toBe("[file: trace.log]");
    expect(contentOf({ imageMessage: {} })).toBe("[photo]");
    // A caption is what the person actually wrote, so it wins over any marker.
    expect(contentOf({ imageMessage: { caption: "look at this" } })).toBe("look at this");
    expect(contentOf({ locationMessage: { name: "office" } })).toBe("[location: office]");
});

test("a protocol notice is not speech and not media", () => {
    expect(contentOf({ protocolMessage: {} })).toBe("");
    expect(hasMedia({ protocolMessage: {} })).toBe(false);
    expect(hasMedia({ audioMessage: {} })).toBe(true);
});

test("a raw timestamp reads whether it is a number or a proto Long", () => {
    expect(timestampOf(groupMessage())).toBe("2025-08-13T16:20:30.000Z");
    expect(timestampOf(groupMessage({ messageTimestamp: { toNumber: () => 1_755_102_030 } }))).toBe("2025-08-13T16:20:30.000Z");
});

test("addressing: DMs always, groups only by @mention (either identity) or reply to us", () => {
    const selves = new Set([SELF, SELF_LID]);
    expect(addressesUs("4915222222222@s.whatsapp.net", { conversation: "hello" }, selves)).toBe(true);
    expect(addressesUs(GROUP, { conversation: "morning all" }, selves)).toBe(false);
    const mentionPhone: WaMessageContent = {
        extendedTextMessage: { text: "@bot status?", contextInfo: { mentionedJid: [`${SELF}@s.whatsapp.net`] } },
    };
    expect(addressesUs(GROUP, mentionPhone, selves)).toBe(true);
    // Groups with hidden numbers mention the @lid identity instead of the phone JID.
    const mentionLid: WaMessageContent = { extendedTextMessage: { text: "@bot?", contextInfo: { mentionedJid: [`${SELF_LID}@lid`] } } };
    expect(addressesUs(GROUP, mentionLid, selves)).toBe(true);
    const replyToUs: WaMessageContent = { extendedTextMessage: { text: "why?", contextInfo: { participant: `${SELF}:3@s.whatsapp.net` } } };
    expect(addressesUs(GROUP, replyToUs, selves)).toBe(true);
    const replyToOther: WaMessageContent = { extendedTextMessage: { text: "why?", contextInfo: { participant: "4915333333333@s.whatsapp.net" } } };
    expect(addressesUs(GROUP, replyToOther, selves)).toBe(false);
});

test("an unaddressed group message dispatches without a turn stream, a typing indicator, or a reply", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createWhatsAppListener(fake.ctx, () => new Map([["whatsapp-1", connection]]));
    listener.onMessage(connection, groupMessage());
    await vi.waitFor(() => expect(fake.dispatched).toHaveLength(1));
    expect(fake.streamed).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(fake.dispatched[0]).toMatchObject({
        provider: "whatsapp",
        type: "message",
        channelId: GROUP,
        author: { id: "4915222222222", name: "Ada" },
        content: "deploy is red again",
    });
    expect(fake.dispatched[0]?.["mentioned"]).toBeUndefined();
});

test("a DM shows typing for the turn and sends the finished reply, unquoted", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createWhatsAppListener(fake.ctx, () => new Map([["whatsapp-1", connection]]));
    const dm = "4915222222222@s.whatsapp.net";
    listener.onMessage(connection, groupMessage({ key: { id: "DM1", remoteJid: dm, fromMe: false } }, { conversation: "hello?" }));
    await vi.waitFor(() => expect(calls.some((call) => call.method === "sendText")).toBe(true));
    expect(fake.streamed[0]).toMatchObject({ mentioned: true, channelId: dm });
    expect(calls.map((call) => call.method)).toEqual(["presence", "sendText", "presence"]);
    expect(calls[0]?.args).toEqual([dm, "composing"]);
    // In a DM there is nothing to disambiguate, so the reply is not marked as a reply to anything.
    expect(calls[1]?.args).toEqual([dm, "on it", undefined]);
    expect(calls[2]?.args).toEqual([dm, "paused"]);
    listener.stopAll();
});

test("a group mention's reply quotes the message it answers", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createWhatsAppListener(fake.ctx, () => new Map([["whatsapp-1", connection]]));
    listener.onMessage(
        connection,
        groupMessage({}, { extendedTextMessage: { text: "@bot status?", contextInfo: { mentionedJid: [`${SELF}@s.whatsapp.net`] } } }),
    );
    await vi.waitFor(() => expect(calls.some((call) => call.method === "sendText")).toBe(true));
    expect(calls.find((call) => call.method === "sendText")?.args).toEqual([GROUP, "on it", "MSG1"]);
    listener.stopAll();
});

test("our own sends and protocol bookkeeping wake nothing", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createWhatsAppListener(fake.ctx, () => new Map([["whatsapp-1", connection]]));
    listener.onMessage(connection, groupMessage({ key: { id: "OURS", remoteJid: GROUP, fromMe: true } }));
    listener.onMessage(connection, groupMessage({ key: { id: "PROTO", remoteJid: GROUP, fromMe: false } }, { protocolMessage: {} }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.dispatched).toHaveLength(0);
    expect(fake.streamed).toHaveLength(0);
});

test("a redelivered message wakes an agent once", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createWhatsAppListener(fake.ctx, () => new Map([["whatsapp-1", connection]]));
    listener.onMessage(connection, groupMessage());
    listener.onMessage(connection, groupMessage());
    await vi.waitFor(() => expect(fake.dispatched).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.dispatched).toHaveLength(1);
});

test("media rides as an attachment reference the download command can use", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createWhatsAppListener(fake.ctx, () => new Map([["whatsapp-1", connection]]));
    listener.onMessage(
        connection,
        groupMessage({ key: { id: "VOICE1", remoteJid: GROUP, fromMe: false } }, { audioMessage: { ptt: true, seconds: 7 } }),
    );
    await vi.waitFor(() => expect(fake.dispatched).toHaveLength(1));
    expect(fake.dispatched[0]).toMatchObject({
        content: "[voice note, 7s]",
        extra: { chatType: "group", attachments: [{ name: "voice note, 7s", id: "VOICE1" }] },
    });
});

test("what the gateway watched go by becomes the history a later mention carries", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const fake = fakeCtx();
    const connection = fakeConnection(calls);
    const listener = createWhatsAppListener(fake.ctx, () => new Map([["whatsapp-1", connection]]));
    listener.onMessage(
        connection,
        groupMessage(
            { key: { id: "M1", remoteJid: GROUP, fromMe: false, participant: "4915222222222@s.whatsapp.net" } },
            { conversation: "release went out at four" },
        ),
    );
    await vi.waitFor(() => expect(fake.dispatched).toHaveLength(1));
    listener.onMessage(
        connection,
        groupMessage(
            { key: { id: "M2", remoteJid: GROUP, fromMe: false, participant: "4915222222222@s.whatsapp.net" } },
            { extendedTextMessage: { text: "@bot what happened?", contextInfo: { mentionedJid: [`${SELF}@s.whatsapp.net`] } } },
        ),
    );
    await vi.waitFor(() => expect(fake.streamed).toHaveLength(1));
    // WhatsApp has no history to fetch — the ring holds what came BEFORE this message, and only that.
    expect(fake.streamed[0]?.["history"]).toEqual([
        { author: { id: "4915222222222", name: "Ada" }, content: "release went out at four", timestamp: "2025-08-13T16:20:30.000Z" },
    ]);
    listener.stopAll();
});
