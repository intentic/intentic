import { keySetFor } from "@intentic/sandbox-contract/protocol/s2s/s2s.testing";
import { attestationIdOf, signAttestation, verifyAttestation, verifyAttestations, verifyIdentity } from "@intentic/sandbox-contract/s2s";
import {
    S2sAttestationsSchema,
    S2sContactSchema,
    S2sMessageSendOutcomeSchema,
    type S2sThreadMessage,
    S2sThreadSchema,
    S2sThreadsListSchema,
    SandboxIdentitySchema,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { Caller } from "../../auth/auth.js";
import { type S2sDaemon, s2sDaemon, until } from "../s2s.testing.js";

// ATTESTATIONS BETWEEN TWO SANDBOXES OVER HTTP, each its real identity, contacts, admission, inbox and outbox on a port: a
// asks b to vouch for it, b's owner vouches from the request, a's owner adds the vouch to a's identity, and a's served
// document then carries one that verifies with b trusted. Neither side acts on what arrives by itself; a person-scoped
// contact carries none; a vouch that does not verify for its receiver is refused at the door, in words its sender sees.

const OWNER_A = "owner@a.test";
const OWNER_B = "owner@b.test";
const DAY = 24 * 60 * 60 * 1000;
// A hang bound, not a latency: an outbox attempt lands in well under a second idle, and has taken past ten on a loaded box.
const SETTLES_MS = 30_000;

const roster = (owner: string) => ({ [owner]: { email: owner, tier: "owner" } satisfies Caller });

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

// A asks B, B's owner accepts: each side's contact id for the other.
const handshake = async (a: S2sDaemon, b: S2sDaemon) => {
    const aToB = S2sContactSchema.parse((await a.http(a.owner, "POST", "/s2s/contacts", { address: b.host })).body).id;
    const asking = async () => (await b.s2s.contacts.list()).find((row) => row.address === a.host);
    await until("b files a's request", async () => (await asking()) !== undefined, SETTLES_MS);
    const bToA = (await asking())?.id ?? "";
    expect((await b.http(b.owner, "POST", `/s2s/contacts/${bToA}/accept`, {})).status).toBe(200);
    await until("a hears the accept", async () => (await a.s2s.contacts.get(aToB))?.state === "accepted", SETTLES_MS);
    return { aToB, bToA };
};

// Every message of every thread the person reads.
const messagesOf = async (made: S2sDaemon): Promise<readonly S2sThreadMessage[]> => {
    const { threads } = S2sThreadsListSchema.parse((await made.http(made.owner, "GET", "/s2s/threads")).body);
    const each = await Promise.all(threads.map(async (thread) => S2sThreadSchema.parse((await made.http(made.owner, "GET", `/s2s/threads/${thread.id}`)).body).messages));
    return each.flat();
};
const arrived = async (made: S2sDaemon, kind: S2sThreadMessage["kind"]): Promise<S2sThreadMessage | undefined> =>
    (await messagesOf(made)).find((message) => message.direction === "in" && message.kind === kind);

test("a asks b to vouch, b vouches from the request, a adds it, and a's document carries it with b trusted", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const { aToB, bToA } = await handshake(a, b);

    const asked = S2sMessageSendOutcomeSchema.parse(
        (await a.http(OWNER_A, "POST", "/s2s/me/attestations/ask", { contact: aToB, claims: { kind: "organisation", organisation: "Acme" }, note: "We met at the meetup." })).body,
    );
    expect(asked.state).toBe("queued");
    await until("b files the request", async () => (await arrived(b, "attestation.request")) !== undefined, SETTLES_MS);
    const request = await arrived(b, "attestation.request");
    expect(request).toMatchObject({ contact: bToA, text: "We met at the meetup.", claims: { kind: "organisation", organisation: "Acme" }, read: false });
    // Nothing is issued and no automation hears it (only the handshake's request was heard): it waits for a person.
    expect(b.heard.map((event) => event.event)).toEqual(["contact.request"]);

    const validUntil = Date.now() + 30 * DAY;
    const issued = S2sMessageSendOutcomeSchema.parse(
        (await b.http(OWNER_B, "POST", "/s2s/attestations/issue", { contact: bToA, claims: { kind: "organisation", organisation: "Acme", verifiedBy: "in-person" }, validUntil, replyTo: request?.id })).body,
    );
    if (issued.state !== "queued") {
        throw new Error(`not queued: ${JSON.stringify(issued)}`);
    }
    // The vouch goes into the request's own thread, and is marked sent once a took it.
    expect(issued.thread).toBe(request?.thread ?? "");
    await until("b's copy is marked sent", async () => (await messagesOf(b)).find((message) => message.id === issued.id)?.delivery?.state === "sent", SETTLES_MS);

    await until("a files the vouch", async () => (await arrived(a, "attestation.issued")) !== undefined, SETTLES_MS);
    const offer = await arrived(a, "attestation.issued");
    const aDoc = await a.identity().document();
    const bDoc = await b.identity().document();
    expect(offer).toMatchObject({
        thread: asked.state === "queued" ? asked.thread : "",
        replyTo: request?.id,
        attestation: { type: "sandbox-vouch", issuer: { fingerprint: bDoc.fingerprint, address: b.host, name: "b" }, subject: { sandbox: aDoc.sandbox, fingerprint: aDoc.fingerprint }, validUntil },
    });
    // Not in a's identity until a person adds it.
    expect(Object.keys(SandboxIdentitySchema.parse((await a.http(undefined, "GET", "/s2s/identity")).body))).not.toContain("attestations");

    const added = await a.http(OWNER_A, "POST", "/s2s/me/attestations", { message: offer?.id });
    expect(added.status).toBe(200);
    const rows = S2sAttestationsSchema.parse(added.body).attestations;
    expect(rows).toEqual([expect.objectContaining({ contact: aToB, message: offer?.id, verified: true, published: true })]);

    const served = SandboxIdentitySchema.parse((await a.http(undefined, "GET", "/s2s/identity")).body);
    expect(verifyIdentity(served)).toEqual({ ok: true });
    const [carried] = served.attestations ?? [];
    if (carried === undefined) {
        throw new Error("a's document carries no attestation");
    }
    expect(verifyAttestation(carried, served, { now: Date.now(), trustedIssuers: [bDoc.fingerprint] })).toEqual({ ok: true, trusted: true });
    expect(verifyAttestations(served, { now: Date.now() })).toEqual([{ id: attestationIdOf(carried), attestation: carried, check: { ok: true, trusted: false } }]);
    // b's own document is as it was: issuing changes nothing of the issuer's identity.
    expect(Object.keys(await b.identity().document())).not.toContain("attestations");

    // Removed by a person: the document is signed again without it.
    expect((await a.http(OWNER_A, "DELETE", `/s2s/me/attestations/${rows[0]?.id ?? ""}`)).body).toEqual({ attestations: [] });
    expect(Object.keys(SandboxIdentitySchema.parse((await a.http(undefined, "GET", "/s2s/identity")).body))).not.toContain("attestations");
});

test("a vouch that does not verify for its receiver is refused at the door, and nothing but an issued one is added", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const { aToB, bToA } = await handshake(a, b);
    const row = await b.s2s.contacts.get(bToA);
    if (row === undefined) {
        throw new Error("no contact");
    }
    const aDoc = await a.identity().document();

    // Signed by b's key, about a key a never held: the door says so, and the outbox ends it at once.
    const stale = signAttestation(
        { issuer: { sandbox: "b-sandbox", address: b.host }, subject: { sandbox: aDoc.sandbox, address: a.host, fingerprint: keySetFor("never a").fingerprint }, claims: {}, issuedAt: Date.now(), validUntil: Date.now() + DAY },
        await b.identity().current(),
    );
    const queued = await b.s2s.outbox.enqueue({ contact: row, payload: { kind: "attestation.issued", attestation: stale } });
    if ("refused" in queued) {
        throw new Error(queued.refused);
    }
    await until("the outbox gives up on it", async () => (await b.s2s.outbox.list()).some((entry) => entry.state === "undelivered"), SETTLES_MS);
    const [ended] = await b.s2s.outbox.list();
    expect(ended?.lastError).toContain("it does not verify against this sandbox's identity: it names key");

    // Signed by a sandbox other than its sender: refused too.
    const someoneElse = signAttestation(
        { issuer: { sandbox: "c-sandbox", address: "c.example" }, subject: { sandbox: aDoc.sandbox, address: a.host, fingerprint: aDoc.fingerprint }, claims: {}, issuedAt: Date.now(), validUntil: Date.now() + DAY },
        keySetFor("c"),
    );
    await b.s2s.outbox.enqueue({ contact: row, payload: { kind: "attestation.issued", attestation: someoneElse } });
    await until("the outbox gives up on that too", async () => (await b.s2s.outbox.list()).filter((entry) => entry.state === "undelivered").length === 2, SETTLES_MS);
    expect((await b.s2s.outbox.list()).map((entry) => entry.lastError)).toContainEqual(expect.stringContaining("an attestation is sent by the sandbox that signed it"));

    // A request is no vouch to add; a message id that names nothing is none either.
    await a.http(OWNER_A, "POST", "/s2s/me/attestations/ask", { contact: aToB, claims: {} });
    await until("b files the request", async () => (await arrived(b, "attestation.request")) !== undefined, SETTLES_MS);
    const request = await arrived(b, "attestation.request");
    expect(await b.http(OWNER_B, "POST", "/s2s/me/attestations", { message: request?.id })).toEqual({
        status: 404,
        body: { error: `no attestation a contact sent is filed as message ${request?.id ?? ""}` },
    });
    expect((await a.http(OWNER_A, "GET", "/s2s/me/attestations")).body).toEqual({ attestations: [] });
});

test("refuses a vouch for longer than a year, for a contact not accepted, or for one that is not a contact", async () => {
    const a = await daemon("a", OWNER_A);
    const b = await daemon("b", OWNER_B);
    const { bToA } = await handshake(a, b);
    expect(await b.http(OWNER_B, "POST", "/s2s/attestations/issue", { contact: bToA, claims: {}, validUntil: Date.now() + 400 * DAY })).toEqual({
        status: 400,
        body: { error: "a vouch is valid from now for at most a year: pick a later date within that" },
    });
    expect(await b.http(OWNER_B, "POST", "/s2s/attestations/issue", { contact: bToA, claims: { Kind: "person" }, validUntil: Date.now() + DAY })).toMatchObject({ status: 400 });
    expect(await b.http(OWNER_B, "POST", "/s2s/attestations/issue", { contact: "c-nobody", claims: {}, validUntil: Date.now() + DAY })).toEqual({
        status: 404,
        body: { error: "no sandbox contact c-nobody here: a person's own route carries no attestations" },
    });
    await b.http(OWNER_B, "POST", `/s2s/contacts/${bToA}/block`);
    expect(await b.http(OWNER_B, "POST", "/s2s/me/attestations/ask", { contact: bToA, claims: {} })).toEqual({
        status: 409,
        body: { error: `${a.host} is blocked here: an attestation goes to an accepted contact` },
    });
});
