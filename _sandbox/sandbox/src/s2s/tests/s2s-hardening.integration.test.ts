import { keySetFor } from "@intentic/sandbox-contract/protocol/s2s/s2s.testing";
import { sealEnvelope, signIdentity } from "@intentic/sandbox-contract/s2s";
import {
    type S2sContact,
    S2sContactSchema,
    S2sGrantsSchema,
    S2sMessageSendOutcomeSchema,
    S2sPairingAnswerSchema,
    type S2sPayload,
    type SandboxIdentity,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { Caller } from "../../auth/auth.js";
import { opt } from "../../opt.js";
import { type S2sDaemon, s2sDaemon, until } from "../s2s.testing.js";

// WHAT A CONTACT MAY NOT DO TO THIS SANDBOX, two and three daemons over HTTP: rewrite the document pinned for it with one
// that names another address, another sandbox or another recovery key; keep this sandbox's wake secret after it leaves,
// whatever state it was in; write over a message this sandbox sent it by reusing that message's id; and a stranger's two
// requests racing make one contact. A key trusted after it changed gives back the state the contact had.

const OWNER_A = "owner@a.test";
const OWNER_B = "owner@b.test";
const ADA = "ada@acme.test";
const VIC = "vic@b.test";

const rosterOf = (owner: string) => ({
    [owner]: { email: owner, tier: "owner" } satisfies Caller,
    [ADA]: { email: ADA, tier: "collaborator", agents: "run" } satisfies Caller,
    [VIC]: { email: VIC, tier: "viewer" } satisfies Caller,
});

let open: S2sDaemon[] = [];
const daemon = async (name: string, roster: Readonly<Record<string, Caller>>): Promise<S2sDaemon> => {
    const made = await s2sDaemon(name, { roster });
    open.push(made);
    return made;
};

afterEach(async () => {
    await Promise.all(open.map((made) => made.close()));
    open = [];
});

const contactOf = (body: unknown): S2sContact => S2sContactSchema.parse(body);

// A asks B, B's owner accepts: answers each side's contact id for the other.
const handshake = async (a: S2sDaemon, b: S2sDaemon, grants: { readonly a?: object; readonly b?: object } = {}) => {
    const aToB = contactOf((await a.http(a.owner, "POST", "/s2s/contacts", { address: b.host, grants: grants.a ?? {} })).body).id;
    const asking = async () => (await b.s2s.contacts.list()).find((row) => row.address === a.host);
    await until("b files a's request", async () => (await asking()) !== undefined);
    const bToA = (await asking())?.id ?? "";
    expect((await b.http(b.owner, "POST", `/s2s/contacts/${bToA}/accept`, { grants: grants.b ?? {} })).status).toBe(200);
    await until("a hears the accept", async () => (await a.s2s.contacts.get(aToB))?.state === "accepted");
    return { aToB, bToA };
};

// An envelope from `from` to `to`, sealed and signed by `from`'s current key, as its outbox would send it.
const envelopeOf = async (from: S2sDaemon, to: S2sDaemon, payload: S2sPayload, id?: string) =>
    sealEnvelope({
        addressing: { ...opt("id", id), from: from.host, to: to.host, kind: payload.kind, hops: 0, sentAt: Date.now() },
        payload,
        sender: await from.identity().current(),
        recipient: (await to.identity().document()).keys,
    });

// `from`'s own document, re-signed by its own key with some facts changed: what a contact could send about itself.
const resigned = async (from: S2sDaemon, change: Partial<Pick<SandboxIdentity, "sandbox" | "host" | "domains" | "recovery">>): Promise<SandboxIdentity> => {
    const document = await from.identity().document();
    const facts = { sandbox: document.sandbox, name: document.name, host: document.host, domains: document.domains, recovery: document.recovery, issuedAt: Date.now(), ...change };
    return signIdentity(facts, await from.identity().current());
};

const RECOVERY_A = `isr1:${"a".repeat(52)}`;
const RECOVERY_B = `isr1:${"b".repeat(52)}`;

test("a document a contact sends about itself is pinned only while it names the same sandbox, its address and its pinned recovery key", async () => {
    const a = await daemon("a", rosterOf(OWNER_A));
    const b = await daemon("b", rosterOf(OWNER_B));
    const { bToA } = await handshake(a, b);
    const pinned = async () => (await b.s2s.contacts.get(bToA))?.document;
    const rotatedWith = async (document: SandboxIdentity) => b.http(undefined, "POST", "/s2s/inbox", await envelopeOf(a, b, { kind: "identity.rotated", document }));

    // Another host, another sandbox id: taken as envelopes (the key is a's), never pinned.
    for (const change of [{ host: "evil.example" }, { sandbox: "someone-else" }]) {
        expect((await rotatedWith(await resigned(a, change))).status).toBe(202);
        expect(await pinned()).toMatchObject({ host: a.host, sandbox: "a-sandbox" });
    }
    // A recovery key where none was pinned is taken; changing it after is not, nor dropping it.
    expect((await rotatedWith(await resigned(a, { recovery: RECOVERY_A }))).status).toBe(202);
    expect((await pinned())?.recovery).toBe(RECOVERY_A);
    expect((await rotatedWith(await resigned(a, { recovery: RECOVERY_B }))).status).toBe(202);
    expect((await pinned())?.recovery).toBe(RECOVERY_A);
    expect((await rotatedWith(await resigned(a, { recovery: undefined }))).status).toBe(202);
    expect((await pinned())?.recovery).toBe(RECOVERY_A);
    // A document that does not verify (its signature over other facts) is never pinned either.
    const forged = { ...(await resigned(a, { recovery: RECOVERY_A })), name: "renamed after signing" };
    expect((await rotatedWith(forged)).status).toBe(202);
    expect((await pinned())?.name).toBe("a");
});

test("an accept's document is pinned only when it verifies and still names the address the contact was added by", async () => {
    const a = await daemon("a", rosterOf(OWNER_A));
    const b = await daemon("b", rosterOf(OWNER_B));
    const aToB = contactOf((await a.http(OWNER_A, "POST", "/s2s/contacts", { address: b.host })).body).id;
    await until("b files a's request", async () => (await b.s2s.contacts.list()).length === 1);
    // b answers by hand, its accept carrying a document of its own key that names another host.
    const accept: S2sPayload = { kind: "contact.accept", document: await resigned(b, { host: "elsewhere.example" }), grants: S2sGrantsSchema.parse({}) };
    expect((await a.http(undefined, "POST", "/s2s/inbox", await envelopeOf(b, a, accept))).status).toBe(202);
    expect(await a.s2s.contacts.get(aToB)).toMatchObject({ state: "accepted", document: { host: b.host } });
});

test("the wake secret goes back whenever a contact once handed it leaves, whatever its state; a viewer's pairing hands none", async () => {
    const aRoster = rosterOf(OWNER_A);
    const a = await daemon("a", aRoster);
    const b = await daemon("b", rosterOf(OWNER_B));
    const c = await daemon("c", rosterOf("owner@c.test"));
    const bDocument = await b.identity().document();

    // A viewer here pairs b as their own route asking for the wake grant: the pairing holds, without the secret.
    const viewers = S2sPairingAnswerSchema.parse((await a.http(VIC, "POST", "/s2s/pairings", { document: bDocument, scope: "person", grants: { wake: true } })).body);
    expect([viewers.wake, viewers.grants.wake]).toEqual([undefined, false]);
    expect((await a.s2s.contacts.get(viewers.contact))?.wakeHeld).toBeUndefined();

    // A collaborator's pairing hands it over; once she leaves the roster, the secret is replaced.
    const adas = S2sPairingAnswerSchema.parse((await a.http(ADA, "POST", "/s2s/pairings", { document: bDocument, scope: "person", grants: { wake: true } })).body);
    const first = await a.s2s.secrets.inbound();
    expect([adas.wake, (await a.s2s.contacts.get(adas.contact))?.wakeHeld]).toEqual([first, true]);
    // She leaves the roster (the suite's roster object is the one the daemon reads).
    Reflect.deleteProperty(aRoster, ADA);
    await a.s2s.sweepLeavers();
    const second = await a.s2s.secrets.inbound();
    expect(second === first).toBe(false);
    expect((await a.s2s.contacts.get(adas.contact))?.wakeHeld).toBeUndefined();
    // Swept once: nothing more is replaced while nobody else leaves.
    await a.s2s.sweepLeavers();
    expect(await a.s2s.secrets.inbound()).toBe(second);

    // A request granting wake carries the secret before it is ever accepted: removing it unanswered replaces the secret.
    const asked = contactOf((await a.http(OWNER_A, "POST", "/s2s/contacts", { address: c.host, grants: { wake: true } })).body);
    await until("c files the request with the secret", async () => (await c.s2s.secrets.theirs((await c.s2s.contacts.list())[0]?.id ?? "")) === second);
    expect((await a.s2s.contacts.get(asked.id))?.state).toBe("pending-out");
    expect((await a.http(OWNER_A, "DELETE", `/s2s/contacts/${asked.id}`)).status).toBe(200);
    expect((await a.s2s.secrets.inbound()) === second).toBe(false);
});

test("an envelope reusing the id of a message this sandbox sent is refused, and the sent message and its files stay", async () => {
    const a = await daemon("a", rosterOf(OWNER_A));
    const b = await daemon("b", rosterOf(OWNER_B));
    const { aToB } = await handshake(a, b);
    const sent = S2sMessageSendOutcomeSchema.parse(
        (await a.http(OWNER_A, "POST", "/s2s/messages", { to: aToB, text: "The release notes.", files: [{ name: "notes.md", data: Buffer.from("# 2.0").toString("base64") }] })).body,
    );
    if (sent.state !== "queued") {
        throw new Error("not queued");
    }
    await until("b takes it", async () => (await b.s2s.threads.list()).length === 1);

    // b sends it back under the very id: a refuses it in words, and its own copy is untouched.
    const reused = await envelopeOf(b, a, { kind: "message", text: "Overwritten.", attachments: [{ name: "notes.md", data: Buffer.from("gone").toString("base64") }] }, sent.id);
    expect(await a.http(undefined, "POST", "/s2s/inbox", reused)).toEqual({
        status: 400,
        body: { error: `a message ${sent.id} is already filed here: an envelope's id is never reused`, code: "malformed" },
    });
    const thread = await a.s2s.threads.get(sent.thread);
    expect(thread?.messages.map((message) => [message.direction, message.text])).toEqual([["out", "The release notes."]]);
    expect((await a.s2s.threads.fileOf(sent.id, "notes.md"))?.toString()).toBe("# 2.0");
});

test("a key trusted after it changed gives the contact back the state it had: a request still waits on a person", async () => {
    const a = await daemon("a", rosterOf(OWNER_A));
    const b = await daemon("b", rosterOf(OWNER_B));
    expect((await a.http(OWNER_A, "POST", "/s2s/contacts", { address: b.host })).status).toBe(200);
    await until("b files the request", async () => (await b.s2s.contacts.list()).length === 1);
    const [request] = await b.s2s.contacts.list();
    a.loseKeys();
    const fresh = (await a.identity().document()).fingerprint;
    // a asks again under its new key: b holds the request as key-changed.
    expect((await a.http(OWNER_A, "POST", "/s2s/contacts", { address: b.host })).status).toBe(200);
    await until("b holds the new key", async () => (await b.s2s.contacts.get(request?.id ?? ""))?.state === "key-changed");
    const trusted = contactOf((await b.http(OWNER_B, "POST", `/s2s/contacts/${request?.id ?? ""}/trust-key`, { fingerprint: fresh })).body);
    expect(trusted).toMatchObject({ state: "pending-in", fingerprint: fresh });
});

test("a stranger's two requests racing make one contact", async () => {
    const a = await daemon("a", rosterOf(OWNER_A));
    const b = await daemon("b", rosterOf(OWNER_B));
    const request: S2sPayload = { kind: "contact.request", document: await a.identity().document(), grants: S2sGrantsSchema.parse({}), scope: { kind: "sandbox" } };
    const [one, two] = await Promise.all([envelopeOf(a, b, request), envelopeOf(a, b, request)]);
    const answers = await Promise.all([b.http(undefined, "POST", "/s2s/inbox", one), b.http(undefined, "POST", "/s2s/inbox", two)]);
    expect(answers.map((answer) => answer.status)).toEqual([202, 202]);
    expect((await b.s2s.contacts.list()).map((row) => [row.address, row.state])).toEqual([[a.host, "pending-in"]]);
});

test("a stranger's request signed by another key than its document's spends nothing and files nothing", async () => {
    const a = await daemon("a", rosterOf(OWNER_A));
    const b = await daemon("b", rosterOf(OWNER_B));
    const request: S2sPayload = { kind: "contact.request", document: await a.identity().document(), grants: S2sGrantsSchema.parse({}), scope: { kind: "sandbox" } };
    const forged = sealEnvelope({
        addressing: { from: a.host, to: b.host, kind: "contact.request", hops: 0, sentAt: Date.now() },
        payload: request,
        sender: keySetFor("mallory"),
        recipient: (await b.identity().document()).keys,
    });
    expect((await b.http(undefined, "POST", "/s2s/inbox", forged)).status).toBe(403);
    expect(b.sent).toEqual([]);
    expect(await b.s2s.contacts.list()).toEqual([]);
});
