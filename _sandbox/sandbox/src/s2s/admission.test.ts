import { keySetFor } from "@intentic/sandbox-contract/protocol/s2s/s2s.testing";
import { type ResolvedAddress, sealEnvelope, signIdentity, vouchFor } from "@intentic/sandbox-contract/s2s";
import { S2sGrantsSchema, type S2sEnvelope, type S2sPayload, type SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import type { Caller } from "../auth/auth.js";
import { type AdmissionDeps, createAdmission, IDENTITY_FETCHES_PER_MINUTE, windowLimiter } from "./admission.js";
import { type ContactRow, sameScope } from "./contacts/contacts-store.js";

// The one admission's order, each check before the next: the recipient, a seen id, a block, a stranger, a key held as
// changed, the signature (and the rotation table where the key changed), the grant, the person's floor, hops, the minute,
// and a handler for the kind; then the body opened.

const A = "a.example";
const B = "b.example";
const aKeys = keySetFor("a");
const bKeys = keySetFor("b");
const docOf = (name: string, host: string, keys = keySetFor(name), prev?: SandboxIdentity["prev"]): SandboxIdentity =>
    signIdentity({ sandbox: name, name, host, domains: [], issuedAt: 1 }, keys, prev);
const aDoc = docOf("a", A, aKeys);
const MESSAGES_ONLY = S2sGrantsSchema.parse({});

const contact = (over: Partial<ContactRow> = {}): ContactRow => ({
    id: "c-a",
    address: A,
    document: aDoc,
    scope: { kind: "sandbox" },
    state: "accepted",
    grants: MESSAGES_ONLY,
    notices: [],
    origin: "request",
    createdAt: 1,
    updatedAt: 1,
    ...over,
});

const ROSTER = [
    { email: "ada@acme.test", tier: "collaborator", agents: "run" },
    { email: "gus@acme.test", tier: "guest", agents: "chat" },
] as const satisfies readonly Caller[];

interface HarnessOptions {
    readonly rows?: readonly ContactRow[];
    readonly seen?: readonly string[];
    readonly resolved?: ResolvedAddress;
    readonly kinds?: readonly string[];
    readonly now?: number;
    readonly hostProblem?: (host: string) => string | undefined;
}

const harness = (options: HarnessOptions = {}) => {
    const rows = [...(options.rows ?? [])];
    const resolves: string[] = [];
    const adopted: string[] = [];
    const held: string[] = [];
    const deps: AdmissionDeps = {
        identity: () => ({ addresses: async () => [B], openWith: async () => [bKeys] }),
        contacts: { list: async () => rows, find: async (address, scope) => rows.find((row) => row.address === address && sameScope(row.scope, scope)) },
        seen: { has: async (id) => options.seen?.includes(id) ?? false },
        resolve: async (address) => {
            resolves.push(address);
            return options.resolved ?? { ok: true, address, host: address, document: aDoc };
        },
        roster: async () => ({ callerOf: (email) => ROSTER.find((caller) => caller.email === email) }),
        kinds: { handlerOf: (kind) => ((options.kinds ?? ["message", "contact.request"]).includes(kind) ? async () => ({ stored: true }) : undefined) },
        keys: {
            adopt: async (row, document, notice) => {
                adopted.push(`${notice}:${document.fingerprint}`);
                return { ...row, document };
            },
            hold: async (_row, document) => {
                held.push(document.fingerprint);
            },
        },
        now: () => options.now ?? 1_000,
        hostProblem: options.hostProblem ?? (() => undefined),
    };
    return { admission: createAdmission(deps), rows, resolves, adopted, held };
};

const message: S2sPayload = { kind: "message", text: "hello", attachments: [] };

const seal = (
    over: { kind?: S2sPayload["kind"]; payload?: S2sPayload; to?: string; hops?: number; as?: string; sender?: typeof aKeys; from?: string; sentAt?: number } = {},
): S2sEnvelope =>
    sealEnvelope({
        addressing: { from: over.from ?? A, to: over.to ?? B, kind: over.kind ?? "message", hops: over.hops ?? 0, sentAt: over.sentAt ?? 1, as: over.as },
        payload: over.payload ?? message,
        sender: over.sender ?? aKeys,
        recipient: bKeys.public,
    });

// The same envelope with another envelope's signature: what a forger or a corrupted body looks like.
const forged = (envelope: S2sEnvelope): S2sEnvelope => ({ ...envelope, sig: seal({ payload: { kind: "message", text: "other", attachments: [] } }).sig });

test("the recipient is checked before anything else: another address or key is refused even for an id already seen", async () => {
    const envelope = seal({ to: "c.example" });
    expect(await harness({ seen: [envelope.id], rows: [contact()] }).admission.admit(envelope)).toEqual({
        kind: "refused",
        code: "recipient",
        error: `this sandbox is not c.example under key ${bKeys.fingerprint}: fetch its identity again`,
    });
    expect(await harness().admission.admit({ ...seal(), kind: "task.later" })).toMatchObject({ kind: "refused", code: "unknown_kind" });
});

test("an id already taken answers as a duplicate before any contact is looked up", async () => {
    const envelope = seal();
    const { admission, resolves } = harness({ seen: [envelope.id] });
    expect(await admission.admit(envelope)).toEqual({ kind: "duplicate", id: envelope.id });
    expect(resolves).toEqual([]);
});

test("a blocked address or key is swallowed before its signature is even read", async () => {
    const envelope = forged(seal());
    expect(await harness({ rows: [contact({ state: "blocked" })] }).admission.admit(envelope)).toEqual({ kind: "swallowed", id: envelope.id });
    // Blocked by its key, from another address.
    const elsewhere = forged(seal({ from: "a2.example" }));
    expect(await harness({ rows: [contact({ state: "blocked" })] }).admission.admit(elsewhere)).toEqual({ kind: "swallowed", id: elsewhere.id });
});

test("a stranger may send only a contact request, refused before any fetch", async () => {
    const { admission, resolves } = harness();
    expect(await admission.admit(forged(seal()))).toMatchObject({ kind: "refused", code: "not_contact" });
    expect(resolves).toEqual([]);
});

test("a stranger's request is confirmed against the document its address serves", async () => {
    const request: S2sPayload = { kind: "contact.request", document: aDoc, grants: MESSAGES_ONLY, scope: { kind: "sandbox" } };
    const envelope = seal({ kind: "contact.request", payload: request });
    const taken = await harness().admission.admit(envelope);
    expect(taken).toMatchObject({ kind: "admitted", received: { contact: undefined, sender: { fingerprint: aKeys.fingerprint }, payload: { kind: "contact.request" } } });

    const other = docOf("x", A);
    expect(await harness({ resolved: { ok: true, address: A, host: A, document: other } }).admission.admit(envelope)).toEqual({
        kind: "refused",
        code: "unconfirmed",
        error: `${A} serves key ${other.fingerprint}, not the ${aKeys.fingerprint} this request was signed with`,
    });
    expect(await harness({ resolved: { ok: false, code: "unreachable", message: `${A} did not answer: timeout` } }).admission.admit(envelope)).toEqual({
        kind: "refused",
        code: "unready",
        error: `${A} could not be confirmed: ${A} did not answer: timeout`,
    });
    // Signed by the address's key, but carrying another document inside: it does not vouch for itself, so nothing is fetched.
    const swapped = seal({ kind: "contact.request", payload: { ...request, document: other } });
    const refusedSwap = harness();
    expect(await refusedSwap.admission.admit(swapped)).toEqual({ kind: "refused", code: "signature", error: "a contact request must be signed by the key its own document carries" });
    expect(refusedSwap.resolves).toEqual([]);
});

const DAY = 24 * 60 * 60 * 1000;

test("an envelope sealed more than a day before it arrives, or more than five minutes ahead, is refused as a replay", async () => {
    const now = 10 * DAY;
    const rows = [contact()];
    expect(await harness({ rows, now }).admission.admit(seal({ sentAt: now - DAY }))).toMatchObject({ kind: "admitted" });
    expect(await harness({ rows, now }).admission.admit(seal({ sentAt: now - DAY - 1 }))).toEqual({
        kind: "refused",
        code: "replay",
        error: "it was sealed more than a day before it arrived: an envelope is sealed afresh at every attempt, so one this old is a replay",
    });
    expect(await harness({ rows, now }).admission.admit(seal({ sentAt: now + 5 * 60 * 1000 }))).toMatchObject({ kind: "admitted" });
    expect(await harness({ rows, now }).admission.admit(seal({ sentAt: now + 5 * 60 * 1000 + 1 }))).toEqual({
        kind: "refused",
        code: "replay",
        error: "it was sealed more than five minutes ahead of this sandbox's clock: check the sending sandbox's clock",
    });
    // Before the seen ids are asked: a stale replay of an id this sandbox forgot is refused, not taken.
    const stale = seal({ sentAt: now - 2 * DAY });
    expect(await harness({ rows, now, seen: [stale.id] }).admission.admit(stale)).toMatchObject({ kind: "refused", code: "replay" });
});

test("a stranger's forged request spends none of its address's hour and fetches nothing", async () => {
    const request: S2sPayload = { kind: "contact.request", document: aDoc, grants: MESSAGES_ONLY, scope: { kind: "sandbox" } };
    const { admission, resolves } = harness();
    for (let tried = 0; tried < 5; tried += 1) {
        expect(await admission.admit(forged(seal({ kind: "contact.request", payload: request })))).toEqual({
            kind: "refused",
            code: "signature",
            error: "a contact request must be signed by the key its own document carries",
        });
    }
    expect(resolves).toEqual([]);
    // Three real requests an hour from the address still go, the fourth is the address's hour.
    for (let asked = 0; asked < 3; asked += 1) {
        expect(await admission.admit(seal({ kind: "contact.request", payload: request }))).toMatchObject({ kind: "admitted" });
    }
    expect(await admission.admit(seal({ kind: "contact.request", payload: request }))).toEqual({ kind: "refused", code: "rate", error: "at most 3 contact requests an hour from one address" });
    expect(resolves).toEqual([A, A, A]);
});

test("a stranger at a host this sandbox does not fetch from is refused before its address is asked", async () => {
    const request: S2sPayload = { kind: "contact.request", document: aDoc, grants: MESSAGES_ONLY, scope: { kind: "sandbox" } };
    const { admission, resolves } = harness({ hostProblem: (host) => (host === A ? "it is a private network address" : undefined) });
    expect(await admission.admit(seal({ kind: "contact.request", payload: request }))).toEqual({
        kind: "refused",
        code: "unconfirmed",
        error: `${A} is no address this sandbox fetches from: it is a private network address`,
    });
    expect(resolves).toEqual([]);
});

test("an envelope naming a key the contact's address does not serve changes nothing, and fetches at most twice a minute", async () => {
    const stranger = keySetFor("mallory");
    const next = keySetFor("a-next");
    // The address now serves an unvouched new key: what a forger hopes to push the contact into `key-changed` with.
    const { admission, resolves, held, adopted } = harness({ rows: [contact()], resolved: { ok: true, address: A, host: A, document: docOf("a", A, next) } });
    for (let tried = 0; tried < IDENTITY_FETCHES_PER_MINUTE; tried += 1) {
        expect(await admission.admit(seal({ sender: stranger }))).toEqual({ kind: "refused", code: "signature", error: "the envelope is signed by a key your address does not serve" });
    }
    expect(await admission.admit(seal({ sender: stranger }))).toEqual({
        kind: "refused",
        code: "rate",
        error: `${A}'s document was already fetched 2 times this minute to check a key it was not pinned to: try again in a minute`,
    });
    expect(resolves).toEqual([A, A]);
    expect(held).toEqual([]);
    expect(adopted).toEqual([]);
});

test("a contact filed under its own domain is found from the host its pinned document names, only under its own key", async () => {
    const H = "h.a.test";
    const onDomain = contact({ document: docOf("a", H, aKeys) });
    expect(await harness({ rows: [onDomain] }).admission.admit(seal({ from: H }))).toMatchObject({ kind: "admitted", received: { contact: { id: "c-a" } } });
    // Another row filed under that host keeps it: a claim in a document never takes an address another contact is filed under.
    const atHost = contact({ id: "c-h", address: H, document: docOf("h", H, keySetFor("h")) });
    const hostServesItsOwn = harness({ rows: [onDomain, atHost], resolved: { ok: true, address: H, host: H, document: atHost.document } });
    expect(await hostServesItsOwn.admission.admit(seal({ from: H }))).toEqual({ kind: "refused", code: "signature", error: "the envelope is signed by a key your address does not serve" });
    expect(hostServesItsOwn.held).toEqual([]);
    // A request from that host under another key is a stranger's, never the domain contact's.
    const request: S2sPayload = { kind: "contact.request", document: docOf("x", H, keySetFor("x")), grants: MESSAGES_ONLY, scope: { kind: "sandbox" } };
    const asked = seal({ kind: "contact.request", payload: request, from: H, sender: keySetFor("x") });
    expect(await harness({ rows: [onDomain], resolved: { ok: true, address: H, host: H, document: request.document } }).admission.admit(asked)).toMatchObject({
        kind: "admitted",
        received: { contact: undefined },
    });
});

test("a limiter remembers at most its cap of keys, the idle and the oldest going first", () => {
    let now = 0;
    const limited = windowLimiter(() => now, 1_000, 3);
    expect(["a", "b", "c", "d", "e"].map((key) => limited(key, 1))).toEqual([false, false, false, false, false]);
    expect(limited.size()).toBe(3);
    // The newest three are still counted.
    expect(limited("e", 1)).toBe(true);
    // Past the cap again once their window is over: every idle key goes, and only the new one is left.
    now = 5_000;
    expect(limited("f", 1)).toBe(false);
    expect(limited("g", 1)).toBe(false);
    expect(limited("h", 1)).toBe(false);
    expect(limited.size()).toBe(3);
    expect(limited("i", 1)).toBe(false);
    expect(limited.size()).toBe(3);
    expect(limited("f", 1)).toBe(false);
});

test("a key held as changed is refused before its signature is checked; a request not yet accepted sends only the handshake", async () => {
    expect(await harness({ rows: [contact({ state: "key-changed" })] }).admission.admit(forged(seal()))).toMatchObject({ kind: "refused", code: "key_changed" });
    expect(await harness({ rows: [contact({ state: "pending-in" })] }).admission.admit(seal())).toMatchObject({ kind: "refused", code: "not_contact" });
    expect(await harness({ rows: [contact()] }).admission.admit(forged(seal()))).toMatchObject({ kind: "refused", code: "signature" });
});

test("a new key vouched by the pinned one is pinned with its notice; one with no proof holds the contact", async () => {
    const next = keySetFor("a-next");
    const vouched = docOf("a", A, next, vouchFor("a", next, { by: "key", keySet: aKeys }, 2));
    const rotated = harness({ rows: [contact()], resolved: { ok: true, address: A, host: A, document: vouched } });
    expect(await rotated.admission.admit(seal({ sender: next }))).toMatchObject({ kind: "admitted", received: { sender: { fingerprint: next.fingerprint } } });
    expect(rotated.adopted).toEqual([`rotated:${next.fingerprint}`]);

    const unvouched = docOf("a", A, next);
    const changed = harness({ rows: [contact()], resolved: { ok: true, address: A, host: A, document: unvouched } });
    expect(await changed.admission.admit(seal({ sender: next }))).toMatchObject({ kind: "refused", code: "key_changed" });
    expect(changed.held).toEqual([next.fingerprint]);
    expect(changed.adopted).toEqual([]);
});

test("the grant, then the person's floor, then hops, then the minute, then a handler for the kind", async () => {
    expect(await harness({ rows: [contact({ grants: { ...MESSAGES_ONLY, message: false } })] }).admission.admit(seal({ hops: 9 }))).toMatchObject({
        kind: "refused",
        code: "grant",
    });
    const gus = contact({ scope: { kind: "person", person: "gus@acme.test" } });
    expect(await harness({ rows: [gus] }).admission.admit(seal({ as: "gus@acme.test", hops: 9 }))).toEqual({
        kind: "refused",
        code: "floor",
        error: "gus@acme.test may not do that here: dropping into this sandbox needs collaborator access here",
    });
    const ada = contact({ scope: { kind: "person", person: "ada@acme.test" } });
    expect(await harness({ rows: [ada] }).admission.admit(seal({ as: "ada@acme.test" }))).toMatchObject({ kind: "admitted", received: { contact: { id: "c-a" } } });
    expect(await harness({ rows: [contact()] }).admission.admit(seal({ hops: 9 }))).toMatchObject({ kind: "refused", code: "hops" });

    const minute = harness({ rows: [contact()] });
    for (let sent = 0; sent < 60; sent += 1) {
        expect(await minute.admission.admit(seal())).toMatchObject({ kind: "admitted" });
    }
    expect(await minute.admission.admit(seal())).toEqual({ kind: "refused", code: "rate", error: "at most 60 message envelopes a minute from one contact" });

    const report: S2sPayload = { kind: "report", project: "github.com/acme/app", report: { kind: "detection", message: "Down" }, times: 1 };
    expect(await harness({ rows: [contact({ grants: { ...MESSAGES_ONLY, report: true } })] }).admission.admit(seal({ kind: "report", payload: report }))).toEqual({
        kind: "refused",
        code: "unready",
        error: "this sandbox takes no report yet: try again later",
    });
});
