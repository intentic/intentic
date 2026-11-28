import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keySetFor } from "@intentic/sandbox-contract/protocol/s2s/s2s.testing";
import { formatTxtRecord, sealEnvelope, signIdentity, type TxtAnswer, txtRecordName } from "@intentic/sandbox-contract/s2s";
import {
    type S2sContact,
    S2sContactSchema,
    S2sContactsListSchema,
    type S2sGrantsInput,
    S2sGrantsSchema,
    S2sMessageSendOutcomeSchema,
    S2sOutboxSchema,
    S2sPairingAnswerSchema,
    type S2sPayload,
    S2sThreadSchema,
    S2sThreadsListSchema,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { Caller } from "../../auth/auth.js";
import { turnProof } from "../../seams/workload-stamp.js";
import { type S2sDaemon, s2sDaemon, until } from "../s2s.testing.js";

// TWO (AND THREE) SANDBOXES OVER HTTP, each its real identity, contacts, admission, inbox and outbox on a port: the
// handshake from request to accept, messages both ways with files and their read state, both halves of an editor pairing
// (the sandbox as itself, and a person's own route held to their floor), what a stranger may not do, a block, a rotation
// the contact follows and a key change it holds until trusted, the outbox through a sleeping sandbox's 503 with `?wake=`,
// the wake secret replaced when a contact holding it is removed, and an envelope taken twice stored once.

const OWNER_A = "owner@a.test";
const OWNER_B = "owner@b.test";
const OWNER_C = "owner@c.test";
const ADA = "ada@acme.test";
const GUS = "gus@acme.test";
const VIC = "vic@b.test";

const roster = (owner: string) => ({
    [owner]: { email: owner, tier: "owner" } satisfies Caller,
    [ADA]: { email: ADA, tier: "collaborator", agents: "run" } satisfies Caller,
    [GUS]: { email: GUS, tier: "guest", agents: "chat" } satisfies Caller,
    [VIC]: { email: VIC, tier: "viewer" } satisfies Caller,
});

let open: S2sDaemon[] = [];
const daemon = async (name: string, owner: string): Promise<S2sDaemon> => {
    const made = await s2sDaemon(name, { roster: roster(owner) });
    open.push(made);
    return made;
};

afterEach(async () => {
    await Promise.all(open.map((made) => made.close()));
    open = [];
});

const base64 = (text: string): string => Buffer.from(text).toString("base64");

const contactOf = (body: unknown): S2sContact => S2sContactSchema.parse(body);

// A asks B, B's owner accepts: answers each side's contact id for the other.
const handshake = async (a: S2sDaemon, b: S2sDaemon, grants: { readonly a?: S2sGrantsInput; readonly b?: S2sGrantsInput } = {}) => {
    const added = await a.http(a.owner, "POST", "/s2s/contacts", { address: b.host, note: "From the a team", grants: grants.a ?? {} });
    expect(added.status).toBe(200);
    const aToB = contactOf(added.body).id;
    const asking = async () => (await b.s2s.contacts.list()).find((row) => row.address === a.host);
    await until("b files a's request", async () => (await asking()) !== undefined);
    const request = await asking();
    if (request === undefined) {
        throw new Error("no request");
    }
    const accepted = await b.http(b.owner, "POST", `/s2s/contacts/${request.id}/accept`, { grants: grants.b ?? {} });
    expect(accepted.status).toBe(200);
    await until("a hears the accept", async () => (await a.s2s.contacts.get(aToB))?.state === "accepted");
    return { aToB, bToA: request.id };
};

const send = async (from: S2sDaemon, as: string, body: { to: string; text: string; subject?: string; thread?: string; files?: { name: string; data: string }[] }) => {
    const answer = await from.http(as, "POST", "/s2s/messages", body);
    expect(answer.status).toBe(200);
    return S2sMessageSendOutcomeSchema.parse(answer.body);
};

const threadsOf = async (made: S2sDaemon, as: string) => S2sThreadsListSchema.parse((await made.http(as, "GET", "/s2s/threads")).body);
const threadOf = async (made: S2sDaemon, as: string, id: string) => S2sThreadSchema.parse((await made.http(as, "GET", `/s2s/threads/${id}`)).body);

test("the handshake: a asks, b holds it for a person and tells automations, b's owner accepts, a sees it accepted", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const added = await a.http(OWNER_A, "POST", "/s2s/contacts", { address: b.host, note: "From the a team", grants: { report: true } });
    const asked = contactOf(added.body);
    expect(asked).toMatchObject({ address: b.host, name: "b", host: b.host, state: "pending-out", origin: "request", note: "From the a team", holdsWake: false });
    expect(asked.fingerprint).toBe((await b.identity().document()).fingerprint);
    expect(asked.grants).toEqual({ message: true, report: true, records: false, operate: false, wake: false });

    await until("b files the request", async () => (await b.s2s.contacts.list()).length === 1);
    const listed = (await b.http(OWNER_B, "GET", "/s2s/contacts")).body;
    expect(listed).toEqual({ contacts: [expect.objectContaining({ address: a.host, state: "pending-in", note: "From the a team", origin: "request" })] });
    const [request] = await b.s2s.contacts.list();
    expect(request?.theirGrants).toEqual({ message: true, report: true, records: false, operate: false, wake: false });
    await until("automations hear the request", () => b.heard.length === 1);
    expect(b.heard.map((event) => [event.event, event.contact.address])).toEqual([["contact.request", a.host]]);
    expect((await threadsOf(b, OWNER_B)).requests).toBe(1);
    // A viewer neither sees nor answers a sandbox-scoped request.
    expect((await b.http(VIC, "GET", "/s2s/contacts")).body).toEqual({ contacts: [] });

    const accepted = await b.http(OWNER_B, "POST", `/s2s/contacts/${request?.id ?? ""}/accept`, { grants: { message: true } });
    expect(contactOf(accepted.body)).toMatchObject({ state: "accepted", grants: { message: true, report: false, records: false, operate: false, wake: false } });
    await until("a hears the accept", async () => (await a.s2s.contacts.get(asked.id))?.state === "accepted");
    expect((await a.s2s.contacts.get(asked.id))?.theirGrants).toEqual({ message: true, report: false, records: false, operate: false, wake: false });
});

test("messages both ways in one thread, with a file, its read state and a receipt back", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const { aToB, bToA } = await handshake(a, b);

    const sent = await send(a, OWNER_A, { to: aToB, subject: "CI", text: "The build fails.", files: [{ name: "log.txt", data: base64("line 1\n") }] });
    if (sent.state !== "queued") {
        throw new Error(`not queued: ${JSON.stringify(sent)}`);
    }
    await until("b files the message", async () => (await threadsOf(b, OWNER_B)).threads.length === 1);
    const [summary] = (await threadsOf(b, OWNER_B)).threads;
    expect(summary).toMatchObject({ contact: bToA, contactName: "a", scope: { kind: "sandbox" }, subject: "CI", unread: 1, messages: 1, undelivered: 0 });
    expect(summary?.last).toMatchObject({ direction: "in", preview: "The build fails." });
    const thread = await threadOf(b, OWNER_B, summary?.id ?? "");
    expect(thread.messages).toEqual([
        expect.objectContaining({ id: sent.id, direction: "in", kind: "message", subject: "CI", text: "The build fails.", attachments: [{ name: "log.txt", size: 7 }], read: false }),
    ]);
    const file = await fetch(`http://${b.host}/s2s/messages/${sent.id}/files/log.txt`, { headers: { "x-test-as": OWNER_B } });
    expect(await file.text()).toBe("line 1\n");
    await until("automations hear the message", () => b.heard.at(-1)?.event === "message");
    expect(b.heard.at(-1)).toMatchObject({ event: "message", thread: summary?.id, envelope: sent.id, subject: "CI", text: "The build fails.", attachments: ["log.txt"] });
    await until("a's copy is marked sent", async () => (await threadOf(a, OWNER_A, sent.thread)).messages[0]?.delivery?.state === "sent");

    const reply = await send(b, OWNER_B, { to: bToA, thread: summary?.id ?? "", text: "On it." });
    expect(reply.state).toBe("queued");
    await until("a files the reply in the same thread", async () => (await threadOf(a, OWNER_A, sent.thread)).messages.length === 2);
    expect((await threadOf(a, OWNER_A, sent.thread)).messages.map((message) => [message.direction, message.text])).toEqual([
        ["out", "The build fails."],
        ["in", "On it."],
    ]);
    expect((await threadsOf(a, OWNER_A)).threads).toHaveLength(1);

    expect((await b.http(OWNER_B, "POST", `/s2s/threads/${summary?.id ?? ""}/read`)).status).toBe(200);
    expect((await threadsOf(b, OWNER_B)).threads[0]?.unread).toBe(0);
    await until("a hears b read it", async () => (await a.s2s.threads.get(sent.thread))?.messages[0]?.theyReadAt !== undefined);

    const taken = await b.http(OWNER_B, "POST", `/s2s/messages/${sent.id}/take`, { dest: "from-a" });
    expect(taken).toEqual({ status: 200, body: { dest: "from-a", files: ["log.txt"] } });
    expect(readFileSync(join(b.root, "workspace", "from-a", "log.txt"), "utf8")).toBe("line 1\n");
    expect((await b.http(OWNER_B, "POST", `/s2s/messages/${sent.id}/take`, { dest: "from-a" })).status).toBe(409);
});

test("an editor pairing, both halves: the sandbox as itself with the wake grant, and a person's own route held to their floor", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const document = await a.identity().document();
    const pairedIn = await b.http(OWNER_B, "POST", "/s2s/pairings", { document, scope: "sandbox", grants: { wake: true }, theirGrants: { report: true } });
    const answer = S2sPairingAnswerSchema.parse(pairedIn.body);
    expect(answer.grants).toEqual({ message: true, report: false, records: false, operate: false, wake: true });
    expect(answer.wake).toBe(await b.s2s.secrets.inbound());
    expect(answer.document.fingerprint).toBe((await b.identity().document()).fingerprint);
    const pairedOut = contactOf((await a.http(OWNER_A, "POST", "/s2s/contacts/paired", { answer, scope: "sandbox", grants: { report: true } })).body);
    expect(pairedOut).toMatchObject({ address: b.host, state: "accepted", origin: "paired", holdsWake: true, scope: { kind: "sandbox" } });
    expect(await b.s2s.contacts.get(answer.contact)).toMatchObject({ state: "accepted", origin: "paired", address: a.host });

    await send(a, OWNER_A, { to: pairedOut.id, text: "Paired." });
    await until("b files it", async () => (await threadsOf(b, OWNER_B)).threads.length === 1);
    expect(a.sent.filter((url) => url.includes("/s2s/inbox"))).toEqual([`http://${b.host}/s2s/inbox?wake=${encodeURIComponent(answer.wake ?? "")}`]);

    // A person pairs their own route; only maintainers pair the sandbox as itself.
    expect((await b.http(ADA, "POST", "/s2s/pairings", { document, scope: "sandbox", grants: {} })).status).toBe(403);
    const adaIn = S2sPairingAnswerSchema.parse((await b.http(ADA, "POST", "/s2s/pairings", { document, scope: "person", grants: { operate: true } })).body);
    expect(adaIn.grants.operate).toBe(false);
    const adaOut = contactOf((await a.http(ADA, "POST", "/s2s/contacts/paired", { answer: adaIn, scope: "person", grants: {} })).body);
    expect(adaOut.scope).toEqual({ kind: "person", person: ADA });
    expect((await a.http(ADA, "GET", "/s2s/contacts")).body).toEqual({ contacts: [expect.objectContaining({ id: adaOut.id })] });
    await send(a, ADA, { to: adaOut.id, text: "As Ada." });
    await until("b files ada's", async () => (await threadsOf(b, ADA)).threads.length === 1);
    expect((await threadOf(b, ADA, (await threadsOf(b, ADA)).threads[0]?.id ?? "")).messages[0]).toMatchObject({ text: "As Ada.", as: ADA });
    expect((await threadsOf(b, VIC)).threads).toEqual([]);
    expect((await threadsOf(b, OWNER_B)).threads).toHaveLength(2);

    // A guest may not drop into a sandbox: their route's message is refused at their floor, and the sender is told why.
    const gusIn = S2sPairingAnswerSchema.parse((await b.http(GUS, "POST", "/s2s/pairings", { document, scope: "person", grants: {} })).body);
    const gusOut = contactOf((await a.http(GUS, "POST", "/s2s/contacts/paired", { answer: gusIn, scope: "person", grants: {} })).body);
    const refused = await send(a, GUS, { to: gusOut.id, text: "As Gus." });
    if (refused.state !== "queued") {
        throw new Error("not queued");
    }
    await until("a marks it undelivered", async () => (await threadOf(a, GUS, refused.thread)).messages[0]?.delivery?.state === "undelivered");
    expect((await threadOf(a, GUS, refused.thread)).messages[0]?.delivery?.reason).toBe(
        `${GUS} may not do that here: dropping into this sandbox needs collaborator access here (floor)`,
    );
});

// A stranger's envelope, its request carrying the stranger's own document (signed by the key that signs the envelope), or
// with `forge` the receiver's own document instead: one that does not vouch for itself.
const strangerEnvelope = async (to: S2sDaemon, kind: "message" | "contact.request", from = "stranger.example", forge = false) => {
    const theirs = await to.identity().document();
    const sender = keySetFor(`stranger ${from}`);
    const own = signIdentity({ sandbox: `stranger-${from}`, name: "stranger", host: from, domains: [], issuedAt: Date.now() }, sender);
    const payload: S2sPayload =
        kind === "message"
            ? { kind: "message", text: "hello", attachments: [] }
            : { kind: "contact.request", document: forge ? theirs : own, grants: S2sGrantsSchema.parse({}), scope: { kind: "sandbox" } };
    return sealEnvelope({ addressing: { from, to: to.host, kind, hops: 0, sentAt: Date.now() }, payload, sender, recipient: theirs.keys });
};

test("a stranger may send only a contact request, at most 3 an hour from one address", async () => {
    const b = await daemon("b", OWNER_B);
    b.intercept = () => new Response("not here", { status: 404 });
    expect(await b.http(undefined, "POST", "/s2s/inbox", await strangerEnvelope(b, "message"))).toEqual({
        status: 403,
        body: { error: "your sandbox is not a contact of this one: ask to be one first (a contact request)", code: "not_contact" },
    });
    // A request that does not vouch for itself is refused before it counts: the address's three still go after it.
    expect(await b.http(undefined, "POST", "/s2s/inbox", await strangerEnvelope(b, "contact.request", "stranger.example", true))).toEqual({
        status: 403,
        body: { error: "a contact request must be signed by the key its own document carries", code: "signature" },
    });
    expect(b.sent).toEqual([]);
    const answers = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
        answers.push(await b.http(undefined, "POST", "/s2s/inbox", await strangerEnvelope(b, "contact.request")));
    }
    expect(answers.map((answer) => answer.status)).toEqual([503, 503, 503, 429]);
    expect(answers[3]?.body).toEqual({ error: "at most 3 contact requests an hour from one address", code: "rate" });
    expect((await b.http(undefined, "POST", "/s2s/inbox", await strangerEnvelope(b, "contact.request", "other.example"))).status).toBe(503);
    expect(await b.s2s.contacts.list()).toEqual([]);
});

// One DNS for the suite's daemons: the TXT records each name holds.
const dnsOf = () => {
    const records = new Map<string, string>();
    const txt = async (name: string): Promise<TxtAnswer> => {
        const value = records.get(name);
        return value === undefined ? { kind: "missing" } : { kind: "records", records: [[value]] };
    };
    return { records, txt };
};

test("a contact added by its own domain completes the handshake, exchanges messages both ways, and takes a call", async () => {
    const dns = dnsOf();
    const a = await s2sDaemon("a", { roster: roster(OWNER_A), txt: dns.txt });
    const b = await s2sDaemon("b", { roster: roster(OWNER_B), txt: dns.txt });
    open.push(a, b);
    const DOMAIN = "b-team.example";
    const bKey = (await b.identity().document()).fingerprint;
    dns.records.set(txtRecordName(DOMAIN), formatTxtRecord({ fingerprint: bKey, host: b.host }));
    await b.identity().claimDomain(DOMAIN);
    await b.identity().checkDomain(DOMAIN);
    expect((await b.identity().document()).domains).toEqual([DOMAIN]);

    const added = contactOf((await a.http(OWNER_A, "POST", "/s2s/contacts", { address: DOMAIN })).body);
    expect(added).toMatchObject({ address: DOMAIN, host: b.host, state: "pending-out", fingerprint: bKey });
    await until("b files a's request", async () => (await b.s2s.contacts.list()).length === 1);
    const [request] = await b.s2s.contacts.list();
    expect(request).toMatchObject({ address: a.host, state: "pending-in" });
    // b answers from its host, which a filed under the domain: the accept still finds the contact.
    expect((await b.http(OWNER_B, "POST", `/s2s/contacts/${request?.id ?? ""}/accept`, { grants: { records: true } })).status).toBe(200);
    await until("a hears the accept", async () => (await a.s2s.contacts.get(added.id))?.state === "accepted");
    expect((await a.s2s.contacts.list()).map((row) => [row.address, row.state])).toEqual([[DOMAIN, "accepted"]]);

    await send(a, OWNER_A, { to: added.id, text: "To your domain." });
    await send(b, OWNER_B, { to: request?.id ?? "", text: "From my host." });
    const received = async (made: S2sDaemon) => (await made.s2s.threads.list()).flatMap((thread) => thread.messages.filter((message) => message.direction === "in").map((message) => message.text));
    await until("both land", async () => (await received(a)).length === 1 && (await received(b)).length === 1);
    expect([await received(a), await received(b)]).toEqual([["From my host."], ["To your domain."]]);

    b.s2s.calls.door.serve({ "records.diagnostics": async () => ({ status: 200, body: { text: "no restarts" } }) });
    const row = await a.s2s.contacts.get(added.id);
    if (row === undefined) {
        throw new Error("no contact");
    }
    expect(await a.s2s.calls.client.call(row, "records.diagnostics", { query: "restarts" })).toEqual({ ok: true, value: { text: "no restarts" } });
});

test("a blocked sender is answered as if taken, and nothing it sends is kept", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const aToB = contactOf((await a.http(OWNER_A, "POST", "/s2s/contacts", { address: b.host })).body).id;
    await until("b files the request", async () => (await b.s2s.contacts.list()).length === 1);
    const [request] = await b.s2s.contacts.list();
    expect(contactOf((await b.http(OWNER_B, "POST", `/s2s/contacts/${request?.id ?? ""}/block`)).body).state).toBe("blocked");
    const heardBefore = b.heard.length;

    const sender = await a.identity().current();
    const envelope = sealEnvelope({
        addressing: { from: a.host, to: b.host, kind: "message", hops: 0, sentAt: Date.now() },
        payload: { kind: "message", text: "Still there?", attachments: [] },
        sender,
        recipient: (await b.identity().document()).keys,
    });
    expect(await b.http(undefined, "POST", "/s2s/inbox", envelope)).toEqual({ status: 202, body: { ok: true, id: envelope.id } });
    expect((await a.http(OWNER_A, "POST", "/s2s/contacts", { address: b.host })).status).toBe(200);
    await until("a's second request lands", async () => (await a.s2s.outbox.list()).every((entry) => entry.state !== "waiting"));
    expect(b.heard.length).toBe(heardBefore);
    expect((await b.s2s.contacts.list()).map((row) => row.state)).toEqual(["blocked"]);
    expect(await b.s2s.threads.list()).toEqual([]);
    expect(await a.s2s.contacts.get(aToB)).toMatchObject({ state: "pending-out" });
});

test("a rotation reaches the contact as identity.rotated, vouched by the old key, and traffic keeps flowing both ways", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const { aToB, bToA } = await handshake(a, b);
    const before = (await a.identity().document()).fingerprint;
    await a.identity().rotate();
    const after = (await a.identity().document()).fingerprint;
    await until("b pins a's new key", async () => (await b.s2s.contacts.get(bToA))?.document.fingerprint === after);
    expect((await b.s2s.contacts.get(bToA))?.notices).toEqual([{ kind: "rotated", at: expect.any(Number), from: before, to: after, seen: false }]);
    expect((await b.s2s.contacts.get(bToA))?.state).toBe("accepted");

    const there = await send(a, OWNER_A, { to: aToB, text: "Signed with the new key." });
    const back = await send(b, OWNER_B, { to: bToA, text: "Sealed to the new key." });
    expect([there.state, back.state]).toEqual(["queued", "queued"]);
    // Each side holds the thread it started and the one the other did.
    const received = async (made: S2sDaemon) => (await made.s2s.threads.list()).flatMap((thread) => thread.messages.filter((message) => message.direction === "in").map((message) => message.text));
    await until("both land", async () => (await received(b)).length === 1 && (await received(a)).length === 1);
    expect([await received(a), await received(b)]).toEqual([["Sealed to the new key."], ["Signed with the new key."]]);
});

test("a key that changes with no proof is held as key-changed, both ways, until a person trusts it", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const { aToB, bToA } = await handshake(a, b);
    a.loseKeys();
    const fresh = (await a.identity().document()).fingerprint;

    const lost = await send(a, OWNER_A, { to: aToB, text: "It is still me." });
    if (lost.state !== "queued") {
        throw new Error("not queued");
    }
    await until("a hears it refused", async () => (await threadOf(a, OWNER_A, lost.thread)).messages[0]?.delivery?.state === "undelivered");
    expect((await threadOf(a, OWNER_A, lost.thread)).messages[0]?.delivery?.reason).toBe(
        `your key changed with no proof this sandbox can check: a person here must trust ${fresh} first (key_changed)`,
    );
    const listed = S2sContactsListSchema.parse((await b.http(OWNER_B, "GET", "/s2s/contacts")).body).contacts;
    expect(listed.find((contact) => contact.id === bToA)).toMatchObject({ state: "key-changed", pendingKey: fresh });

    // Held both ways: b's own message waits instead of going.
    const held = await send(b, OWNER_B, { to: bToA, text: "Held for now." });
    expect(held.state).toBe("queued");
    await until("b holds it", async () => (await b.s2s.outbox.list())[0]?.lastError === "its key changed with no proof: trust the new one on the Messages tab first");
    expect((await b.http(OWNER_B, "POST", `/s2s/contacts/${bToA}/trust-key`, { fingerprint: `isk1:${"a".repeat(52)}` })).status).toBe(409);

    const trusted = contactOf((await b.http(OWNER_B, "POST", `/s2s/contacts/${bToA}/trust-key`, { fingerprint: fresh })).body);
    expect(trusted).toMatchObject({ state: "accepted", fingerprint: fresh });
    await until("b's held message lands", async () => (await a.s2s.threads.list()).length === 2);
    await send(a, OWNER_A, { to: aToB, text: "Trusted now." });
    await until("a's lands", async () => (await b.s2s.threads.list()).length === 2);
});

test("the outbox retries through a sleeping sandbox's 503, carrying its wake secret, and the second attempt lands", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const { aToB } = await handshake(a, b, { b: { wake: true } });
    const secret = await b.s2s.secrets.inbound();
    await until("a holds b's wake secret", async () => (await a.s2s.secrets.theirs(aToB)) === secret);
    expect(await b.s2s.wakeSecret()).toBe(secret);
    a.sent.length = 0;
    a.intercept = (url) => (url.includes("/s2s/inbox") ? new Response("waking", { status: 503, headers: { "retry-after": "0" } }) : undefined);

    const sent = await send(a, OWNER_A, { to: aToB, text: "Wake up." });
    await until("the first attempt meets the edge", async () => (await a.s2s.outbox.list())[0]?.attempts === 1);
    expect((await a.s2s.outbox.list())[0]).toMatchObject({ state: "waiting", attempts: 1, lastError: "it answered 503" });
    const outbox = S2sOutboxSchema.parse((await a.http(OWNER_A, "GET", "/s2s/outbox")).body);
    expect(outbox.entries).toEqual([expect.objectContaining({ kind: "message", state: "waiting", attempts: 1, contactName: "b", lastError: "it answered 503" })]);
    a.intercept = undefined;
    await a.s2s.outbox.drain();
    expect(a.sent.filter((url) => url.includes("/s2s/inbox"))).toEqual([
        `http://${b.host}/s2s/inbox?wake=${encodeURIComponent(secret)}`,
        `http://${b.host}/s2s/inbox?wake=${encodeURIComponent(secret)}`,
    ]);
    expect(await a.s2s.outbox.list()).toEqual([]);
    expect(sent.state === "queued" ? (await threadOf(a, OWNER_A, sent.thread)).messages[0]?.delivery : undefined).toEqual({ state: "sent", attempts: 2 });
    expect((await b.s2s.threads.list()).map((thread) => thread.messages.map((message) => message.text))).toEqual([["Wake up."]]);
});

test("removing a contact that held the wake secret replaces it, and every other wake-granted contact receives the new one", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const c = await daemon("c", OWNER_C);
    const withB = await handshake(b, a, { b: { wake: true } });
    const withC = await handshake(c, a, { b: { wake: true } });
    const first = await a.s2s.secrets.inbound();
    await until("b and c hold a's secret", async () => (await b.s2s.secrets.theirs(withB.aToB)) === first && (await c.s2s.secrets.theirs(withC.aToB)) === first);

    expect(await a.http(OWNER_A, "DELETE", `/s2s/contacts/${withB.bToA}`)).toEqual({ status: 200, body: { ok: true } });
    const second = await a.s2s.secrets.inbound();
    expect(second).not.toBe(first);
    await until("c holds the new secret", async () => (await c.s2s.secrets.theirs(withC.aToB)) === second);
    await until("b hears it was removed", async () => (await b.s2s.contacts.get(withB.aToB))?.notices.some((notice) => notice.kind === "removed") === true);
    expect(await b.s2s.secrets.theirs(withB.aToB)).toBeUndefined();
    expect(await a.s2s.wakeSecret()).toBe(second);
});

test("an envelope taken twice is stored once: the retry is answered as a duplicate", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    await handshake(a, b);
    const envelope = sealEnvelope({
        addressing: { from: a.host, to: b.host, kind: "message", hops: 0, sentAt: Date.now() },
        payload: { kind: "message", text: "Once.", attachments: [] },
        sender: await a.identity().current(),
        recipient: (await b.identity().document()).keys,
    });
    expect(await b.http(undefined, "POST", "/s2s/inbox", envelope)).toEqual({ status: 202, body: { ok: true, id: envelope.id } });
    expect(await b.http(undefined, "POST", "/s2s/inbox", envelope)).toEqual({ status: 200, body: { ok: true, id: envelope.id, duplicate: true } });
    expect((await b.s2s.threads.list()).map((thread) => thread.messages.map((message) => message.id))).toEqual([[envelope.id]]);
});

test("an agent's send is held to the owner's action rules, and a turn sees only the contacts it may use", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const { aToB } = await handshake(a, b);
    const turn = { "x-intentic-conversation": "conv-ops", "x-intentic-turn-proof": turnProof("conv-ops") };
    // The turn acts for the owner (its chain names nobody), so it uses the sandbox's own contacts.
    expect(S2sContactsListSchema.parse((await a.http(undefined, "GET", "/s2s/contacts", undefined, turn)).body).contacts.map((row) => row.id)).toEqual([aToB]);
    expect((await a.http(undefined, "GET", "/s2s/contacts")).body).toEqual({ contacts: [] });

    a.rules = { "messages.message.send": "deny" };
    expect(await a.http(undefined, "POST", "/s2s/messages", { to: aToB, text: "From the agent." }, turn)).toEqual({
        status: 200,
        body: { state: "refused", reason: "messages message.send is refused by the action rules" },
    });
    // A person's own send is theirs, whatever the rules say of an agent's.
    expect((await send(a, OWNER_A, { to: aToB, text: "From the owner." })).state).toBe("queued");
    a.rules = {};
    expect((await a.http(undefined, "POST", "/s2s/messages", { to: aToB, text: "From the agent." }, turn)).body).toMatchObject({ state: "queued" });
    await until("both land", async () => (await b.s2s.threads.list()).length === 2);
});
