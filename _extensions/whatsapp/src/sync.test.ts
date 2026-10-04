import { IN_MEMORY } from "@intentic/base/sqlite";
import { PROTOCOL_EDIT, PROTOCOL_REVOKE } from "./content.js";
import { openWaStore } from "./store.js";
import { createStoreSync, recentOf, resolveChatIn, senderOf } from "./sync.js";
import type { WaMessageContent, WaRawMessage } from "./types.js";

/* Baileys' account events, replayed into a real store: what WhatsApp hands a linked device has to come out the other
 * side as people, chats and a chat log the CLI can read. */

const phone = (digits: string): string => `${digits}@s.whatsapp.net`;
const lid = (digits: string): string => `${digits}@lid`;
const GROUP = `${"120363000000000001"}@g.us`;
const VICHETA = { phone: phone("85512345678"), lid: lid("987654321") };

const setup = () => {
    const store = openWaStore(IN_MEMORY);
    return { store, sync: createStoreSync(store, (raw, own) => JSON.stringify({ own, id: raw.key.id })) };
};

const raw = (id: string, content: WaMessageContent, over: Partial<WaRawMessage["key"]> = {}, ts = 1_755_102_000): WaRawMessage => ({
    key: { id, remoteJid: VICHETA.lid, fromMe: false, ...over },
    pushName: "Vee",
    messageTimestamp: ts,
    message: content,
});

test("a history set lands its LID pairs, contacts, chats with Long timestamps and messages, and names the chats it touched", () => {
    const { store, sync } = setup();
    const touched = sync.history({
        lidPnMappings: [{ lid: VICHETA.lid, pn: VICHETA.phone }],
        contacts: [{ id: VICHETA.phone, name: "Vicheta Samnang" }],
        chats: [
            { id: VICHETA.lid, conversationTimestamp: { low: 1_755_000_000, high: 0, toNumber: () => 1_755_000_000 } },
            { id: GROUP, name: "Family" },
            { id: null },
        ],
        messages: [raw("H1", { conversation: "remember dinner" })],
    });
    expect([...touched]).toEqual([VICHETA.lid]);
    expect(store.directory().toSorted((a, b) => a.jid.localeCompare(b.jid))).toEqual([
        { jid: GROUP, kind: "group", chatName: "Family" },
        // The chat's last message (1_755_102_000) is later than the conversation timestamp, and wins.
        { jid: VICHETA.lid, kind: "dm", phone: VICHETA.phone, lid: VICHETA.lid, name: "Vicheta Samnang", lastAt: 1_755_102_000 },
    ]);
    expect(store.recent(VICHETA.lid, 5)).toEqual([
        { chat: VICHETA.lid, id: "H1", fromMe: false, author: VICHETA.lid, authorName: "Vee", text: "remember dinner", ts: 1_755_102_000, raw: `{"own":false,"id":"H1"}` },
    ]);
});

test("an edit and a delete change the message they name instead of becoming messages of their own", () => {
    const { store, sync } = setup();
    sync.messages([raw("M1", { conversation: "see you at 7" }), raw("M2", { conversation: "oops" })]);
    sync.messages([
        raw("E1", { protocolMessage: { type: PROTOCOL_EDIT, key: { id: "M1" }, editedMessage: { conversation: "see you at 8" } } }),
        raw("R1", { protocolMessage: { type: PROTOCOL_REVOKE, key: { id: "M2" } } }),
    ]);
    expect(store.recent(VICHETA.lid, 10).map((row) => [row.id, row.text])).toEqual([
        ["M1", "see you at 8 [edited]"],
        ["M2", "[deleted]"],
    ]);
});

test("a reaction is kept as a line of the chat, and an empty one as its removal; wordless bookkeeping is not kept", () => {
    const { store, sync } = setup();
    sync.messages([
        raw("X1", { reactionMessage: { key: { id: "M1" }, text: "❤️" } }),
        raw("X2", { reactionMessage: { key: { id: "M1" }, text: "" } }),
        raw("X3", { protocolMessage: {} }),
        raw("X4", {}),
    ]);
    expect(store.recent(VICHETA.lid, 10).map((row) => row.text)).toEqual(["[reacted ❤️ to M1]", "[removed a reaction from M1]"]);
});

test("our own sends are kept whole and have no author; a group message's author is its participant", () => {
    const { store, sync } = setup();
    sync.messages([raw("OWN", { conversation: "hi" }, { fromMe: true }), raw("G1", { conversation: "hello all" }, { remoteJid: GROUP, participant: `${VICHETA.lid}` })]);
    expect(store.message("OWN")).toMatchObject({ fromMe: true, raw: `{"own":true,"id":"OWN"}` });
    expect(store.message("OWN")?.author).toBeUndefined();
    expect(store.message("G1")).toMatchObject({ chat: GROUP, author: VICHETA.lid });
});

test("the address pair a v7 message carries teaches the LID map, from a DM and from a group", () => {
    const { store, sync } = setup();
    sync.messages([raw("D1", { conversation: "hi" }, { remoteJidAlt: VICHETA.phone })]);
    expect(store.phoneForLid(VICHETA.lid)).toBe(VICHETA.phone);
    const other = { phone: phone("85511111111"), lid: lid("555666777") };
    sync.messages([raw("G1", { conversation: "hey" }, { remoteJid: GROUP, participant: other.phone, participantAlt: other.lid })]);
    expect(store.lidForPhone(other.phone)).toBe(other.lid);
});

test("a group's participants teach both of their addresses and the name they go by", () => {
    const { store, sync } = setup();
    sync.groups([{ id: GROUP, subject: "Family", participants: [{ id: VICHETA.lid, phoneNumber: VICHETA.phone, notify: "Vee" }] }]);
    expect(store.phoneForLid(VICHETA.lid)).toBe(VICHETA.phone);
    expect(store.resolve("vee")).toMatchObject({ kind: "found", entry: { jid: VICHETA.lid, notify: "Vee" } });
    expect(store.nameOf(GROUP)).toBe("Family");
});

test("a sender is named by the owner's saved name first, and an unpaired @lid asks the session's own key files", async () => {
    const { store } = setup();
    const asked: string[] = [];
    const lookup = async (address: string): Promise<string | undefined> => {
        asked.push(address);
        return VICHETA.phone;
    };
    const message = raw("S1", { conversation: "hi" });
    expect(await senderOf(store, message, lookup)).toEqual({ phone: VICHETA.phone, lid: VICHETA.lid, name: "Vee" });
    expect(asked).toEqual([VICHETA.lid]);
    store.upsertContacts([{ id: VICHETA.phone, lid: VICHETA.lid, name: "Vicheta Samnang" }]);
    expect(await senderOf(store, message, lookup)).toEqual({ phone: VICHETA.phone, lid: VICHETA.lid, name: "Vicheta Samnang" });
    // Known now, so the key files are not read again.
    expect(asked).toEqual([VICHETA.lid]);
});

test("recent leaves out the message being dispatched and still returns `limit` others", () => {
    const { store, sync } = setup();
    sync.messages([raw("A", { conversation: "a" }, {}, 1), raw("B", { conversation: "b" }, {}, 2), raw("C", { conversation: "c" }, {}, 3)]);
    expect(recentOf(store, VICHETA.lid, 2, "C").map((row) => row.id)).toEqual(["A", "B"]);
    expect(recentOf(store, VICHETA.lid, 2).map((row) => row.id)).toEqual(["B", "C"]);
});

test("a chat given as a number, a JID in either spelling, or a name settles on the chat to send to", async () => {
    const { store } = setup();
    const noLid = async (): Promise<string | undefined> => undefined;
    expect(await resolveChatIn(store, "+855 12 345 678", noLid)).toEqual({ kind: "jid", jid: VICHETA.phone });
    // Baileys' key files know this number's @lid: a fresh chat goes there, not to a phone thread nobody else sees.
    expect(await resolveChatIn(store, "+855 12 345 678", async () => VICHETA.lid)).toEqual({ kind: "jid", jid: VICHETA.lid });
    expect(await resolveChatIn(store, `85512345678@c.us`, noLid)).toEqual({ kind: "jid", jid: VICHETA.phone });
    expect(await resolveChatIn(store, GROUP, noLid)).toEqual({ kind: "jid", jid: GROUP });
    store.upsertContacts([{ id: VICHETA.phone, lid: VICHETA.lid, name: "Vicheta Samnang" }]);
    expect(await resolveChatIn(store, "vicheta", noLid)).toEqual({ kind: "jid", jid: VICHETA.lid, label: "Vicheta Samnang" });
    expect(await resolveChatIn(store, "nobody", noLid)).toEqual({ kind: "none" });
});
