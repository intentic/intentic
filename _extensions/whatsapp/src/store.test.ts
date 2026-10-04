import { IN_MEMORY } from "@intentic/base/sqlite";
import { foldName, MESSAGES_PER_CHAT, openWaStore, type StoredMessage } from "./store.js";

/* WhatsApp tells a linked device who the owner's contacts are once, by phone JID and by @lid in no fixed order, and a
 * person may write from either address. The store keeps one person per human, and names them the way the owner does. */

// JIDs built from their digits, so each reads as the number it is.
const phone = (digits: string): string => `${digits}@s.whatsapp.net`;
const lid = (digits: string): string => `${digits}@lid`;
const group = (id: string): string => `${id}@g.us`;

const VICHETA = { phone: phone("85512345678"), lid: lid("987654321") };
const VICHEA = { phone: phone("85599999999"), lid: lid("111222333") };

const message = (over: Partial<StoredMessage> & { id: string }): StoredMessage => ({
    chat: VICHETA.lid,
    fromMe: false,
    author: VICHETA.lid,
    text: `text of ${over.id}`,
    ts: 1_755_102_000,
    ...over,
});

test("a person known by phone in the address book and by @lid in a chat is one directory entry, addressed through that chat", () => {
    const store = openWaStore(IN_MEMORY);
    store.upsertContacts([{ id: VICHETA.phone, lid: VICHETA.lid, name: "Vicheta Samnang" }]);
    store.upsertContacts([{ id: VICHETA.lid, notify: "Vee" }]);
    store.upsertChats([{ id: VICHETA.lid, name: null, lastAt: 1_755_000_000 }]);
    expect(store.directory()).toEqual([
        { jid: VICHETA.lid, kind: "dm", phone: VICHETA.phone, lid: VICHETA.lid, name: "Vicheta Samnang", notify: "Vee", lastAt: 1_755_000_000 },
    ]);
});

test("an empty or missing name from a later event never erases one already known", () => {
    const store = openWaStore(IN_MEMORY);
    store.upsertContacts([{ id: VICHETA.phone, name: "Vicheta Samnang", notify: "Vee" }]);
    store.upsertContacts([{ id: VICHETA.phone, name: "", notify: null }]);
    expect(store.nameOf(VICHETA.phone)).toBe("Vicheta Samnang");
    expect(store.search("vee")[0]).toMatchObject({ name: "Vicheta Samnang", notify: "Vee" });
});

test("a name resolves when it is exact or a unique word prefix, and lists the candidates when it is not", () => {
    const store = openWaStore(IN_MEMORY);
    store.upsertContacts([
        { id: VICHETA.phone, lid: VICHETA.lid, name: "Vicheta Samnang" },
        { id: VICHEA.phone, lid: VICHEA.lid, name: "Vichea Sok" },
    ]);
    expect(store.resolve("vicheta samnang")).toMatchObject({ kind: "found", entry: { jid: VICHETA.lid, name: "Vicheta Samnang" } });
    expect(store.resolve("Samnang")).toMatchObject({ kind: "found", entry: { jid: VICHETA.lid } });
    // Both start with "vich": the store will not guess between two people.
    const both = store.resolve("Vich");
    expect(both.kind).toBe("ambiguous");
    expect(both.kind === "ambiguous" ? both.candidates.map((entry) => entry.name).toSorted() : []).toEqual(["Vichea Sok", "Vicheta Samnang"]);
    expect(store.resolve("Dara")).toEqual({ kind: "none" });
});

test("a loose substring hit resolves only when nothing else matches at all", () => {
    const store = openWaStore(IN_MEMORY);
    store.upsertContacts([{ id: VICHETA.phone, name: "Vicheta Samnang" }]);
    expect(store.resolve("chet")).toMatchObject({ kind: "found", entry: { name: "Vicheta Samnang" } });
    store.upsertContacts([{ id: VICHEA.phone, name: "Chetra Kim" }]);
    // "Chetra" is a word-prefix match and outranks the substring inside "Vicheta".
    expect(store.resolve("chet")).toMatchObject({ kind: "found", entry: { name: "Chetra Kim" } });
});

test("names match without case or Latin accents, and scripts with their own marks match themselves", () => {
    expect(foldName("  José   ÁLVAREZ ")).toBe("jose alvarez");
    const store = openWaStore(IN_MEMORY);
    store.upsertContacts([
        { id: VICHETA.phone, name: "José Álvarez" },
        { id: VICHEA.phone, name: "វិចិត្រា" },
    ]);
    expect(store.resolve("jose")).toMatchObject({ kind: "found", entry: { name: "José Álvarez" } });
    expect(store.resolve("វិចិត្រា")).toMatchObject({ kind: "found", entry: { name: "វិចិត្រា" } });
});

test("a number finds the person it belongs to", () => {
    const store = openWaStore(IN_MEMORY);
    store.upsertContacts([{ id: VICHETA.phone, name: "Vicheta Samnang" }]);
    expect(store.search("+855 1234")).toMatchObject([{ name: "Vicheta Samnang" }]);
});

test("a group listed as a history-sync contact becomes a chat named by its subject, searchable like a person", () => {
    const store = openWaStore(IN_MEMORY);
    store.upsertContacts([{ id: group("120363000000000001"), name: "Family" }]);
    expect(store.contactCount()).toBe(0);
    expect(store.resolve("family")).toMatchObject({ kind: "found", entry: { jid: group("120363000000000001"), kind: "group", chatName: "Family" } });
    expect(store.nameOf(group("120363000000000001"))).toBe("Family");
});

test("a phone number is sent through the chat WhatsApp keeps for that person, else their @lid, else the number", () => {
    const store = openWaStore(IN_MEMORY);
    expect(store.chatForPhone(VICHETA.phone)).toBe(VICHETA.phone);
    expect(store.chatForPhone(VICHETA.phone, VICHETA.lid)).toBe(VICHETA.lid);
    // An existing chat under the phone JID wins over a @lid nobody has a chat under.
    store.upsertChats([{ id: VICHETA.phone }]);
    expect(store.chatForPhone(VICHETA.phone, VICHETA.lid)).toBe(VICHETA.phone);
    store.mapLid(VICHETA.lid, VICHETA.phone);
    store.upsertChats([{ id: VICHETA.lid }]);
    expect(store.chatForPhone(VICHETA.phone)).toBe(VICHETA.lid);
});

test("the LID map ignores pairs that are not one @lid and one phone JID, and strips device suffixes", () => {
    const store = openWaStore(IN_MEMORY);
    store.mapLid(VICHETA.phone, VICHETA.lid);
    expect(store.phoneForLid(VICHETA.lid)).toBeUndefined();
    store.mapLid(`987654321:3@lid`, `85512345678:3@s.whatsapp.net`);
    expect(store.phoneForLid(VICHETA.lid)).toBe(VICHETA.phone);
    expect(store.lidForPhone(VICHETA.phone)).toBe(VICHETA.lid);
});

test("a chat's log keeps the first copy of a message, reads back oldest first, and drops its oldest past the cap", () => {
    const store = openWaStore(IN_MEMORY);
    store.addMessages([message({ id: "A", ts: 100 }), message({ id: "B", ts: 200 })]);
    // The same message replayed by a later history sync changes nothing.
    store.addMessages([message({ id: "A", ts: 100, text: "replayed" })]);
    expect(store.recent(VICHETA.lid, 10).map((row) => [row.id, row.text])).toEqual([
        ["A", "text of A"],
        ["B", "text of B"],
    ]);
    expect(store.recent(VICHETA.lid, 10, 200).map((row) => row.id)).toEqual(["A"]);
    expect(store.oldest(VICHETA.lid)?.id).toBe("A");

    store.addMessages(Array.from({ length: MESSAGES_PER_CHAT }, (_unused, index) => message({ id: `N${index}`, ts: 1_000 + index })));
    expect(store.countIn(VICHETA.lid)).toBe(MESSAGES_PER_CHAT);
    expect(store.message("A")).toBeUndefined();
    expect(store.oldest(VICHETA.lid)?.id).toBe("N0");
});

test("an edit rewrites a stored message's text, and a delete keeps the line but drops its words and its raw form", () => {
    const store = openWaStore(IN_MEMORY);
    store.addMessages([message({ id: "A", raw: "{}" }), message({ id: "B", raw: "{}" })]);
    store.editMessage(VICHETA.lid, "A", "fixed [edited]");
    store.deleteMessage(VICHETA.lid, "B");
    expect(store.message("A", VICHETA.lid)).toMatchObject({ text: "fixed [edited]", raw: "{}" });
    expect(store.message("B", VICHETA.lid)).toEqual({ chat: VICHETA.lid, id: "B", fromMe: false, author: VICHETA.lid, text: "[deleted]", ts: 1_755_102_000 });
});

test("status updates, broadcast lists and channels are not chats", () => {
    const store = openWaStore(IN_MEMORY);
    store.addMessages([message({ id: "S", chat: "status@broadcast" }), message({ id: "N", chat: "120363@newsletter" })]);
    store.upsertChats([{ id: "1234@broadcast" }]);
    expect(store.directory()).toEqual([]);
    expect(store.message("S")).toBeUndefined();
});

test("meta values survive alongside the data, and closing twice is harmless", () => {
    const store = openWaStore(IN_MEMORY);
    expect(store.meta("contacts_synced_at")).toBeUndefined();
    store.setMeta("contacts_synced_at", "1");
    store.setMeta("contacts_synced_at", "2");
    expect(store.meta("contacts_synced_at")).toBe("2");
    store.close();
    store.close();
});
