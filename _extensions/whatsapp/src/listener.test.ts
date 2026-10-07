import { WORKSPACE_ROOT } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import type { GatewayCtx } from "@intentic/connector-runtime";
import { contentOf, hasMedia, jidUser, timestampOf, unwrap } from "./content.js";
import { addressesUs, createWhatsAppListener } from "./listener.js";
import { fakeWhatsApp, SELF, SELF_LID } from "./testing.js";
import type { WaMessageContent, WaRawMessage } from "./types.js";

// A contact WhatsApp also knows by @lid; built from its digits so the test reads as a number, not an address.
const VEE_DIGITS = "85512345678";
const VEE_PHONE = `${VEE_DIGITS}@s.whatsapp.net`;
const VEE_LID = `${"987654321"}@lid`;
const GROUP = "1203630000000000@g.us";

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
                    onFrame({ automationId: "a1", delta: "on it" });
                    onFrame({ automationId: "a1", end: true });
                },
                failure: async () => {},
                status: async () => {},
            },
        },
    };
};

const groupMessage = (over: Partial<WaRawMessage> = {}, content: WaMessageContent = { conversation: "deploy is failing again" }): WaRawMessage => ({
    key: { id: "MSG1", remoteJid: GROUP, fromMe: false, participant: "4915222222222@s.whatsapp.net" },
    pushName: "Ada",
    messageTimestamp: 1_755_102_030,
    message: content,
    ...over,
});

const mentionUs = (text: string): WaMessageContent => ({ extendedTextMessage: { text, contextInfo: { mentionedJid: [`${SELF}@s.whatsapp.net`] } } });

// A listener wired to the fake connection, with the daemon's dispatches recorded.
const harness = () => {
    const wa = fakeWhatsApp();
    const daemon = fakeCtx();
    const listener = createWhatsAppListener(daemon.ctx, () => new Map([["whatsapp-1", wa.connection]]));
    return { ...wa, ...daemon, listener, deliver: (raw: WaRawMessage) => wa.deliver(listener, raw) };
};

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

test("a raw timestamp reads whether it is a number, a proto Long, or a Long that went through JSON", () => {
    expect(timestampOf(groupMessage())).toBe("2025-08-13T16:20:30.000Z");
    expect(timestampOf(groupMessage({ messageTimestamp: { toNumber: () => 1_755_102_030 } }))).toBe("2025-08-13T16:20:30.000Z");
    // SAFETY: a Long that went through JSON is exactly {low, high}; the type only admits the live Long, as baileys sends it.
    expect(timestampOf({ ...groupMessage(), messageTimestamp: { low: 1_755_102_030, high: 0 } as never })).toBe("2025-08-13T16:20:30.000Z");
});

test("addressing: DMs always, groups only by @mention (either identity) or reply to us", () => {
    const selves = new Set([SELF, SELF_LID]);
    expect(addressesUs("4915222222222@s.whatsapp.net", { conversation: "hello" }, selves)).toBe(true);
    expect(addressesUs(GROUP, { conversation: "morning all" }, selves)).toBe(false);
    expect(addressesUs(GROUP, mentionUs("@bot status?"), selves)).toBe(true);
    // Groups with hidden numbers mention the @lid identity instead of the phone JID.
    const mentionLid: WaMessageContent = { extendedTextMessage: { text: "@bot?", contextInfo: { mentionedJid: [`${SELF_LID}@lid`] } } };
    expect(addressesUs(GROUP, mentionLid, selves)).toBe(true);
    const replyToUs: WaMessageContent = { extendedTextMessage: { text: "why?", contextInfo: { participant: `${SELF}:3@s.whatsapp.net` } } };
    expect(addressesUs(GROUP, replyToUs, selves)).toBe(true);
    const replyToOther: WaMessageContent = { extendedTextMessage: { text: "why?", contextInfo: { participant: "4915333333333@s.whatsapp.net" } } };
    expect(addressesUs(GROUP, replyToOther, selves)).toBe(false);
});

test("an unaddressed group message dispatches without a turn stream, a typing indicator, or a reply", async () => {
    const h = harness();
    h.deliver(groupMessage());
    await waitFor(() => expect(h.dispatched).toHaveLength(1));
    expect(h.streamed).toHaveLength(0);
    expect(h.calls).toEqual([]);
    expect(h.dispatched[0]).toMatchObject({
        provider: "whatsapp",
        type: "message",
        channelId: GROUP,
        author: { id: "4915222222222", name: "Ada" },
        content: "deploy is failing again",
    });
    expect(h.dispatched[0]?.["mentioned"]).toBeUndefined();
});

test("a DM shows typing for the turn and sends the finished reply, unquoted", async () => {
    const h = harness();
    const dm = "4915222222222@s.whatsapp.net";
    h.deliver(groupMessage({ key: { id: "DM1", remoteJid: dm, fromMe: false } }, { conversation: "hello?" }));
    await waitFor(() => expect(h.calls.some((call) => call.method === "sendText")).toBe(true));
    expect(h.streamed[0]).toMatchObject({ mentioned: true, channelId: dm });
    expect(h.calls.map((call) => call.method)).toEqual(["presence", "sendText", "presence"]);
    expect(h.calls[0]?.args).toEqual([dm, "composing"]);
    // In a DM there is nothing to disambiguate, so the reply is not marked as a reply to anything.
    expect(h.calls[1]?.args).toEqual([dm, "on it", undefined]);
    expect(h.calls[2]?.args).toEqual([dm, "paused"]);
    h.listener.stopAll();
});

test("a group mention's reply quotes the message it answers", async () => {
    const h = harness();
    h.deliver(groupMessage({}, mentionUs("@bot status?")));
    await waitFor(() => expect(h.calls.some((call) => call.method === "sendText")).toBe(true));
    expect(h.calls.find((call) => call.method === "sendText")?.args).toEqual([GROUP, "on it", "MSG1"]);
    h.listener.stopAll();
});

test("our own sends, protocol bookkeeping and reactions wake nothing", async () => {
    const h = harness();
    h.deliver(groupMessage({ key: { id: "OURS", remoteJid: GROUP, fromMe: true } }));
    h.deliver(groupMessage({ key: { id: "PROTO", remoteJid: GROUP, fromMe: false } }, { protocolMessage: {} }));
    h.deliver(groupMessage({ key: { id: "REACT", remoteJid: GROUP, fromMe: false, participant: "4915222222222@s.whatsapp.net" } }, { reactionMessage: { key: { id: "OURS" }, text: "👍" } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.dispatched).toHaveLength(0);
    expect(h.streamed).toHaveLength(0);
    // The reaction is still part of the chat's record.
    expect(h.store.recent(GROUP, 10).map((row) => row.text)).toEqual(["deploy is failing again", "[reacted 👍 to OURS]"]);
});

test("a redelivered message wakes an agent once", async () => {
    const h = harness();
    h.deliver(groupMessage());
    h.deliver(groupMessage());
    await waitFor(() => expect(h.dispatched).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.dispatched).toHaveLength(1);
});

test("media rides as an attachment reference the download command can use", async () => {
    const h = harness();
    h.deliver(groupMessage({ key: { id: "VOICE1", remoteJid: GROUP, fromMe: false } }, { audioMessage: { ptt: true, seconds: 7 } }));
    await waitFor(() => expect(h.dispatched).toHaveLength(1));
    expect(h.dispatched[0]).toMatchObject({
        content: "[voice note, 7s]",
        extra: { chatType: "group", attachments: [{ name: "voice note, 7s", id: "VOICE1" }] },
    });
});

test("a mention carries the chat's stored history, our own replies marked as ours, and not the message itself", async () => {
    const h = harness();
    // History synced before this process started (a restart, or the sync at pairing) counts as much as live traffic.
    h.sync.messages([
        groupMessage({ key: { id: "M0", remoteJid: GROUP, fromMe: true }, messageTimestamp: 1_755_102_000 }, { conversation: "shipping at four" }),
    ]);
    h.deliver(groupMessage({ key: { id: "M1", remoteJid: GROUP, fromMe: false, participant: "4915222222222@s.whatsapp.net" } }, { conversation: "release went out at four" }));
    await waitFor(() => expect(h.dispatched).toHaveLength(1));
    h.deliver(groupMessage({ key: { id: "M2", remoteJid: GROUP, fromMe: false, participant: "4915222222222@s.whatsapp.net" } }, mentionUs("@bot what happened?")));
    await waitFor(() => expect(h.streamed).toHaveLength(1));
    expect(h.streamed[0]?.["history"]).toEqual([
        { author: { id: SELF, name: "you" }, content: "shipping at four", timestamp: "2025-08-13T16:20:00.000Z", self: true },
        { author: { id: "4915222222222", name: "Ada" }, content: "release went out at four", timestamp: "2025-08-13T16:20:30.000Z" },
    ]);
    h.listener.stopAll();
});

test("a sender WhatsApp addresses by @lid is named by phone number, which is what sender rules are written in", async () => {
    const h = harness();
    // v7 sends the phone JID alongside a LID-addressed DM.
    h.deliver({
        key: { id: "L1", remoteJid: VEE_LID, remoteJidAlt: VEE_PHONE, fromMe: false },
        pushName: "Vee",
        messageTimestamp: 1_755_102_030,
        message: { conversation: "hi" },
    });
    await waitFor(() => expect(h.streamed).toHaveLength(1));
    expect(h.streamed[0]).toMatchObject({ channelId: VEE_LID, author: { id: VEE_DIGITS, name: "Vee" } });
    // ...and the pair is learned, so a later message without it still resolves.
    expect(h.store.phoneForLid(VEE_LID)).toBe(VEE_PHONE);
    h.deliver({
        key: { id: "L2", remoteJid: GROUP, participant: VEE_LID, fromMe: false },
        pushName: "Vee",
        messageTimestamp: 1_755_102_031,
        message: { conversation: "morning" },
    });
    await waitFor(() => expect(h.dispatched).toHaveLength(1));
    expect(h.dispatched[0]).toMatchObject({ author: { id: VEE_DIGITS } });
    h.listener.stopAll();
});

test("the owner's saved name wins over the name a sender set for themselves", async () => {
    const h = harness();
    h.store.upsertContacts([{ id: VEE_PHONE, lid: VEE_LID, name: "Vicheta Samnang" }]);
    h.deliver({ key: { id: "N1", remoteJid: VEE_LID, fromMe: false }, pushName: "Vee", messageTimestamp: 1_755_102_030, message: { conversation: "hi" } });
    await waitFor(() => expect(h.streamed).toHaveLength(1));
    expect(h.streamed[0]).toMatchObject({ author: { id: VEE_DIGITS, name: "Vicheta Samnang" } });
    h.listener.stopAll();
});

test("a reply carries what it replies to, and says when that was us", async () => {
    const h = harness();
    h.deliver(
        groupMessage(
            {},
            {
                extendedTextMessage: {
                    text: "this one?",
                    contextInfo: { stanzaId: "OLD1", participant: `${SELF}@s.whatsapp.net`, quotedMessage: { conversation: "which build broke" } },
                },
            },
        ),
    );
    await waitFor(() => expect(h.streamed).toHaveLength(1));
    expect(h.streamed[0]).toMatchObject({ mentioned: true, extra: { replyTo: { id: "OLD1", author: "you", text: "which build broke" } } });
    h.listener.stopAll();
});
