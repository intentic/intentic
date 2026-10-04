import { createControlRoutes } from "./routes.js";
import { fakeWhatsApp } from "./testing.js";

/* What the `whatsapp` CLI prints is what the model reads, so a refusal must say what to do next: the people an
 * ambiguous name could mean, or the command that lists who exists. */

const phone = (digits: string): string => `${digits}@s.whatsapp.net`;
const lid = (digits: string): string => `${digits}@lid`;
const VICHETA = { phone: phone("85512345678"), lid: lid("987654321") };
const VICHEA = { phone: phone("85599999999"), lid: lid("111222333") };

const harness = (connected = true) => {
    const wa = fakeWhatsApp();
    const handle = createControlRoutes({
        ready: () => (connected ? wa.connection : undefined),
        connections: () => new Map([["whatsapp-1", wa.connection]]),
        mediaDir: "/tmp/wa-media",
        log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const post = (path: string, payload: object) => handle({ method: "POST", url: path }, async () => JSON.stringify(payload));
    const get = (path: string) => handle({ method: "GET", url: path }, async () => "");
    return { ...wa, post, get };
};

test("a message addressed by name goes to that person's chat, and the answer says who it reached", async () => {
    const h = harness();
    h.store.upsertContacts([{ id: VICHETA.phone, lid: VICHETA.lid, name: "Vicheta Samnang" }]);
    expect(await h.post("/send", { chat: "Vicheta", text: "**hello**" })).toEqual({ body: `Sent to Vicheta Samnang (${VICHETA.lid}).` });
    expect(h.calls).toEqual([{ method: "sendText", args: [VICHETA.lid, "**hello**", undefined] }]);
});

test("a name that fits two people sends nothing and lists both, each with the JID that picks it", async () => {
    const h = harness();
    h.store.upsertContacts([
        { id: VICHETA.phone, lid: VICHETA.lid, name: "Vicheta Samnang", notify: "Vee" },
        { id: VICHEA.phone, name: "Vichea Sok" },
    ]);
    const answer = await h.post("/send", { chat: "vich", text: "hi" });
    expect(answer?.status).toBe(409);
    expect(answer?.body.split("\n").toSorted()).toEqual(
        [
            `"vich" could mean any of these; send to one by its JID:`,
            `${VICHETA.lid}\tdm\tVicheta Samnang\t+85512345678\t~Vee`,
            `${VICHEA.phone}\tdm\tVichea Sok\t+85599999999`,
        ].toSorted(),
    );
    expect(h.calls).toEqual([]);
});

test("a name nobody has points at the command that lists who exists", async () => {
    const h = harness();
    const answer = await h.post("/send", { chat: "Dara", text: "hi" });
    expect(answer).toEqual({
        status: 404,
        body: 'No contact, group or chat matches "Dara". `whatsapp contacts <part of a name>` lists who this number knows; a phone number with its country code always works.',
    });
});

test("a reply quotes the message it names, a voice note goes as one, and a reaction names its message", async () => {
    const h = harness();
    await h.post("/send", { chat: VICHETA.lid, text: "yes", reply: "M1" });
    await h.post("/send-file", { chat: VICHETA.lid, path: "/work/note.mp3", voice: true });
    await h.post("/send-file", { chat: VICHETA.lid, path: "/work/report.pdf" });
    expect(await h.post("/react", { chat: VICHETA.lid, id: "M1", emoji: "❤️" })).toEqual({ body: `Reacted ❤️ to M1 in ${VICHETA.lid}.` });
    expect(await h.post("/react", { chat: VICHETA.lid, id: "M1", emoji: "" })).toEqual({ body: "Removed the reaction on M1." });
    expect(h.calls).toEqual([
        { method: "sendText", args: [VICHETA.lid, "yes", "M1"] },
        { method: "sendVoice", args: [VICHETA.lid, "/work/note.mp3"] },
        { method: "sendFile", args: [VICHETA.lid, "/work/report.pdf"] },
        { method: "react", args: [VICHETA.lid, "M1", "❤️"] },
        { method: "react", args: [VICHETA.lid, "M1", ""] },
    ]);
});

test("history reads oldest first, names the owner's own lines as `you`, and gives each message's id", async () => {
    const h = harness();
    h.store.upsertContacts([{ id: VICHETA.phone, lid: VICHETA.lid, name: "Vicheta Samnang" }]);
    h.store.addMessages([
        { chat: VICHETA.lid, id: "A1", fromMe: false, author: VICHETA.lid, authorName: "Vee", text: "dinner?", ts: 1_755_102_000 },
        { chat: VICHETA.lid, id: "A2", fromMe: true, text: "at 8", ts: 1_755_102_060 },
    ]);
    expect(await h.get(`/history?chat=${encodeURIComponent("vicheta samnang")}&limit=5`)).toEqual({
        body: [
            `Vicheta Samnang (${VICHETA.lid}), last 2 message(s), oldest first:`,
            "2025-08-13 16:20  Vicheta Samnang: dinner?  [A1]",
            "2025-08-13 16:21  you: at 8  [A2]",
        ].join("\n"),
    });
});

test("contacts needs a query, and lists every way a match goes by", async () => {
    const h = harness();
    h.store.upsertContacts([{ id: VICHETA.phone, name: "Vicheta Samnang", notify: "Vee" }]);
    expect(await h.get("/contacts?q=")).toEqual({ status: 400, body: "Give part of a name or number: `whatsapp contacts <query>`." });
    expect(await h.get("/contacts?q=vee")).toEqual({ body: `${VICHETA.phone}\tdm\tVicheta Samnang\t+85512345678\t~Vee` });
    expect(await h.get("/contacts?q=nobody")).toEqual({ body: 'Nobody matches "nobody".' });
});

test("missing fields are refused before anything is sent", async () => {
    const h = harness();
    expect(await h.post("/send", { chat: VICHETA.lid })).toEqual({ status: 400, body: "chat and text required" });
    expect(await h.post("/send", { text: "hi" })).toEqual({ status: 400, body: "chat required" });
    expect(await h.post("/react", { chat: VICHETA.lid, id: "M1" })).toEqual({ status: 400, body: "chat, id and emoji required" });
    expect(h.calls).toEqual([]);
});

test("with no paired device every command says so, and an unknown route is left to the gateway", async () => {
    const h = harness(false);
    expect(await h.post("/send", { chat: VICHETA.lid, text: "hi" })).toEqual({
        status: 503,
        body: "WhatsApp is not connected, pair the device from the capability card first.",
    });
    expect(await h.get("/nope")).toBeUndefined();
});
