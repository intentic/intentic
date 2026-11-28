import { scopeRefusal } from "@intentic/sandbox-contract/protocol/member-reach";
import type { PassScope } from "@intentic/sandbox-contract/protocol/doors/pass-scopes";
import { classifyIdentityChange, type IdentityChange, normalizeAddress, type OpenRefusal, openEnvelope, openSelfSigned, type ResolvedAddress, verifyEnvelope, verifyIdentity } from "@intentic/sandbox-contract/s2s";
import {
    isS2sPayloadKind,
    S2S_CALLS,
    S2S_ENVELOPE_MAX_AGE_MS,
    S2S_ENVELOPE_MAX_AHEAD_MS,
    S2S_MAX_HOPS,
    S2S_PER_MINUTE,
    S2S_REFUSAL_STATUS,
    S2S_STRANGER_REQUESTS_PER_ADDRESS_HOUR,
    S2S_STRANGER_REQUESTS_PER_HOUR,
    type S2sCallMethod,
    type S2sContactNoticeKind,
    type S2sEnvelope,
    type S2sGrants,
    type S2sPayloadKind,
    type S2sRefusalCode,
    type S2sSigningKeys,
    type SandboxIdentity,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { Caller } from "../auth/auth.js";
import { type ContactRow, type ContactsStore, sameScope, scopeOfAs } from "./contacts/contacts-store.js";
import type { S2sIdentity } from "./identity/s2s-identity.js";
import type { S2sKinds, S2sReceived } from "./messages/kinds.js";
import type { SeenIds } from "./seen-ids.js";

// THE ONE ADMISSION (docs/architecture/messages.md, "Receiving"): every envelope at POST /s2s/inbox passes these checks
// in this order, cheapest first, so a refusal costs as little as the earliest check that can say no:
// 1. parse, recipient (one of this sandbox's addresses, sealed to its current or a kept previous key), a known kind, and
//    `sentAt` within a day behind and five minutes ahead of this clock (else `replay`, never retried);
// 2. an id already taken answers as a duplicate and changes nothing;
// 3. the contact for `from` and `as` (filed under that address, or naming it as its own host or domain: contactFor): a
//    blocked address or key is swallowed (answered as if taken, nothing kept); a key held as changed is refused; a contact
//    not accepted yet sends only the handshake's kinds; no contact admits only a stranger's `contact.request` (below);
// 4. the signature against the pinned key; a different key fetches the sender's document (at most twice a minute per
//    address) and, only when the envelope verifies under it, applies the rotation table (classifyIdentityChange), pinning
//    a vouched one with its notice and holding an unvouched one as `key-changed`;
// 5. the kind's grant, and for a person-scoped contact that person on the roster above the kind's floor;
// 6. hops; 7. the contact's minute for the kind;
// 8. a handler for the kind (else 503, retried), then the body opened.
// A stranger's request is opened first and must verify against the document it embeds, before it spends anything: then
// its address must be a public host, a handler must take requests, it counts against 3 an hour per address and 30 in all,
// and only then is its address asked for its document, which must hold the very key the request was signed with.
// The pieces a call session needs (the contact, the signer, the grant, the floor) are exported for the calls door.

export type AdmitRefusal = { readonly kind: "refused"; readonly code: S2sRefusalCode; readonly error: string };

export type Admission =
    | { readonly kind: "admitted"; readonly received: S2sReceived }
    | { readonly kind: "duplicate" | "swallowed"; readonly id: string }
    | AdmitRefusal;

const refusal = (code: S2sRefusalCode, error: string): AdmitRefusal => ({ kind: "refused", code, error });

// One step's answer: what it found, or why the envelope goes no further.
export type Step<T> = { readonly kind: "ok"; readonly value: T } | AdmitRefusal;
const ok = <T>(value: T): Step<T> => ({ kind: "ok", value });

/** The HTTP status a refusal answers with (S2S_REFUSAL_STATUS). */
export const refusalStatus = (code: S2sRefusalCode): (typeof S2S_REFUSAL_STATUS)[S2sRefusalCode] => S2S_REFUSAL_STATUS[code];

// What admission does to a contact whose key changed: pin a vouched document with its notice, or hold the contact.
export interface KeyChanges {
    readonly adopt: (row: ContactRow, document: SandboxIdentity, notice: S2sContactNoticeKind) => Promise<ContactRow>;
    readonly hold: (row: ContactRow, document: SandboxIdentity) => Promise<void>;
}

export interface AdmissionDeps {
    readonly identity: () => Pick<S2sIdentity, "addresses" | "openWith">;
    readonly contacts: Pick<ContactsStore, "list" | "find">;
    readonly seen: Pick<SeenIds, "has">;
    // resolveAddress, with the daemon's DNS and fetch.
    readonly resolve: (address: string) => Promise<ResolvedAddress>;
    readonly roster: () => Promise<{ readonly callerOf: (email: string) => Caller | undefined }>;
    readonly kinds: Pick<S2sKinds, "handlerOf">;
    readonly keys: KeyChanges;
    readonly now: () => number;
    // Why a host is no address this sandbox fetches from (s2s-wiring.ts hostProblem: a loopback, private or link-local one),
    // or undefined; absent, every host is.
    readonly hostProblem?: (host: string) => string | undefined;
}

const isS2sCallMethod = (kind: string): kind is S2sCallMethod => Object.hasOwn(S2S_CALLS, kind);

// The kinds a contact may send before it is accepted: the handshake and what keeps it going.
const BEFORE_ACCEPT = {
    "pending-out": new Set<string>(["contact.request", "contact.accept", "contact.update", "contact.remove", "identity.rotated"]),
    "pending-in": new Set<string>(["contact.request", "contact.update", "contact.remove", "identity.rotated"]),
} as const satisfies Readonly<Record<"pending-out" | "pending-in", ReadonlySet<string>>>;

const TASK_KINDS: ReadonlySet<S2sPayloadKind> = new Set(["task.request", "task.message", "task.answer", "task.stop"]);

// The grant a kind or a call method needs; a kind absent here needs none beyond the contact being accepted.
const grantOf = (kind: S2sPayloadKind | S2sCallMethod): ((grants: S2sGrants) => boolean) | undefined => {
    if (isS2sCallMethod(kind)) {
        const grant = S2S_CALLS[kind].grant;
        return grant === "task" ? (grants) => grants.task !== undefined : (grants) => grants[grant];
    }
    if (kind === "message") {
        return (grants) => grants.message;
    }
    if (kind === "report") {
        return (grants) => grants.report;
    }
    return TASK_KINDS.has(kind) ? (grants) => grants.task !== undefined : undefined;
};

// The pass scope whose floor a person-scoped contact's person is held to for a kind (member-reach.ts scopeRefusal).
const floorOf = (kind: S2sPayloadKind): PassScope | undefined => {
    if (kind === "message") {
        return "drop";
    }
    if (kind === "report") {
        return "report";
    }
    return TASK_KINDS.has(kind) ? "task" : undefined;
};

// The minute limit a kind counts against. A task's pushed status is no new work, so it counts as a message, as a receipt does.
const minuteOf = (kind: S2sPayloadKind): keyof typeof S2S_PER_MINUTE =>
    kind === "report" ? "report" : TASK_KINDS.has(kind) ? "task" : "message";

// How many keys one limiter remembers: past it, the keys with nothing in the window go first, then the oldest, so a flood
// of addresses costs memory up to here and no further. A key let go early only forgets its own window.
const LIMITER_KEYS_MAX = 10_000;
// How often one address's document is fetched to weigh a key it was not pinned to, at most, a minute.
export const IDENTITY_FETCHES_PER_MINUTE = 2;

// A sliding window per key, in memory: a restart forgets it, which costs at most one more window.
export const windowLimiter = (now: () => number, windowMs: number, maxKeys = LIMITER_KEYS_MAX) => {
    const stamps = new Map<string, number[]>();
    const sweep = (at: number): void => {
        for (const [key, held] of stamps) {
            if (held.every((stamp) => at - stamp >= windowMs)) {
                stamps.delete(key);
            }
        }
        for (const key of stamps.keys()) {
            if (stamps.size <= maxKeys) {
                break;
            }
            stamps.delete(key);
        }
    };
    const limited = (key: string, max: number): boolean => {
        const at = now();
        const recent = (stamps.get(key) ?? []).filter((stamp) => at - stamp < windowMs);
        const over = recent.length >= max;
        if (!over) {
            recent.push(at);
        }
        stamps.set(key, recent);
        if (stamps.size > maxKeys) {
            sweep(at);
        }
        return over;
    };
    return Object.assign(limited, { size: (): number => stamps.size });
};

// Step 3's answer: who sent it as far as the address and `as` say, before any signature is checked.
export type ContactLookup =
    | { readonly kind: "contact"; readonly row: ContactRow }
    | { readonly kind: "stranger" }
    | { readonly kind: "blocked" }
    | AdmitRefusal;

// What the rotation table's verdict does: the notice a vouched key is pinned with, or how a change is refused.
const noticeOf = (change: IdentityChange): S2sContactNoticeKind | "held" | undefined => {
    switch (change.kind) {
        case "rotated":
        case "recovered":
        case "rekeyed-by-domain":
            return change.kind;
        case "key-changed":
            return "held";
        default:
            return undefined;
    }
};

// Whether a pinned document names an address as its own: its host or one of its domains.
const namesAddress = (row: ContactRow, address: string): boolean => normalizeAddress(row.document.host) === address || row.document.domains.includes(address);

/**
 * The row an envelope from `from` in a scope comes over: the one filed under that address; else the one whose pinned
 * document names that address as its host or a domain and whose pinned key signed it (a contact added by its own domain
 * sends from its host); else, for anything but a request, the one row that names the address at all while no row is filed
 * under it (that contact's key just changed: the rotation table weighs it against the address the row is filed under).
 * One contact's claim never takes an address another row is filed under, nor an envelope another key signed.
 */
const rowFor = (rows: readonly ContactRow[], from: string, as: string | undefined, fromFp: string, kind: string): ContactRow | undefined => {
    const scope = scopeOfAs(as);
    const inScope = rows.filter((row) => row.state !== "blocked" && sameScope(row.scope, scope));
    const exact = inScope.find((row) => row.address === from);
    if (exact !== undefined) {
        return exact;
    }
    const naming = inScope.filter((row) => namesAddress(row, from));
    const signed = naming.filter((row) => row.document.fingerprint === fromFp);
    if (signed.length === 1) {
        return signed[0];
    }
    const [only] = naming;
    return kind === "contact.request" || naming.length !== 1 || rows.some((row) => row.address === from) ? undefined : only;
};

// What a stranger's self-signed request that did not open is refused as.
const strangerOpenRefusal = (reason: OpenRefusal): AdmitRefusal => {
    switch (reason) {
        case "signature":
            return refusal("signature", "a contact request must be signed by the key its own document carries");
        case "recipient":
            return refusal("recipient", "it is sealed to no key this sandbox holds");
        default:
            return refusal("malformed", `the body does not open (${reason})`);
    }
};

/** Step 4 for a stranger: the document its address serves, which must hold the key it signed with. */
const strangerSignerOf =
    (deps: Pick<AdmissionDeps, "resolve">) =>
    async (from: string, fromFp: string, verify: (keys: S2sSigningKeys) => boolean): Promise<Step<SandboxIdentity>> => {
        const resolved = await deps.resolve(from);
        if (!resolved.ok) {
            const transient = resolved.code === "unreachable" || resolved.code === "dns";
            return refusal(transient ? "unready" : "unconfirmed", `${from} could not be confirmed: ${resolved.message}`);
        }
        if (resolved.document.fingerprint !== fromFp) {
            return refusal("unconfirmed", `${from} serves key ${resolved.document.fingerprint}, not the ${fromFp} this request was signed with`);
        }
        return verify(resolved.document.keys) ? ok(resolved.document) : refusal("signature", "the signature does not verify against the key your address serves");
    };

export const createAdmission = (deps: AdmissionDeps) => {
    const perHour = windowLimiter(deps.now, 60 * 60 * 1000);
    const perMinute = windowLimiter(deps.now, 60 * 1000);
    const fetches = windowLimiter(deps.now, 60 * 1000);

    /** Step 3: the contact an envelope from `from` (as `as`, signed by `fromFp`) comes over, a stranger, or blocked. */
    const contactFor = async (from: string, as: string | undefined, fromFp: string, kind: string): Promise<ContactLookup> => {
        const rows = await deps.contacts.list();
        if (rows.some((row) => row.state === "blocked" && (row.address === from || row.document.fingerprint === fromFp))) {
            return { kind: "blocked" };
        }
        const row = rowFor(rows, from, as, fromFp, kind);
        if (row === undefined) {
            return kind === "contact.request" ? { kind: "stranger" } : refusal("not_contact", "your sandbox is not a contact of this one: ask to be one first (a contact request)");
        }
        if (row.state === "key-changed") {
            return refusal("key_changed", `${row.address}'s key changed with no proof: this sandbox holds its messages until a person here trusts the new key`);
        }
        if ((row.state === "pending-out" || row.state === "pending-in") && !BEFORE_ACCEPT[row.state].has(kind)) {
            return refusal("not_contact", "this sandbox has not accepted yours as a contact yet: only the handshake goes until it does");
        }
        return { kind: "contact", row };
    };

    /** A stranger's request, past its own signature: its address a public host, then the hour's budgets. */
    const strangerBudget = (from: string): AdmitRefusal | undefined => {
        const problem = deps.hostProblem?.(from);
        if (problem !== undefined) {
            return refusal("unconfirmed", `${from} is no address this sandbox fetches from: ${problem}`);
        }
        if (perHour(`address:${from}`, S2S_STRANGER_REQUESTS_PER_ADDRESS_HOUR)) {
            return refusal("rate", `at most ${S2S_STRANGER_REQUESTS_PER_ADDRESS_HOUR} contact requests an hour from one address`);
        }
        return perHour("strangers", S2S_STRANGER_REQUESTS_PER_HOUR) ? refusal("rate", "this sandbox takes no more contact requests this hour") : undefined;
    };

    /** Step 4 for a contact: the document whose keys signed, after the rotation table where the key changed. */
    const signerOf = async (row: ContactRow, fromFp: string, verify: (keys: S2sSigningKeys) => boolean): Promise<Step<SandboxIdentity>> => {
        if (fromFp === row.document.fingerprint) {
            return verify(row.document.keys) ? ok(row.document) : refusal("signature", "the signature does not verify against the key this sandbox pinned for you");
        }
        if (fetches(`identity:${row.address}`, IDENTITY_FETCHES_PER_MINUTE)) {
            return refusal("rate", `${row.address}'s document was already fetched ${IDENTITY_FETCHES_PER_MINUTE} times this minute to check a key it was not pinned to: try again in a minute`);
        }
        const resolved = await deps.resolve(row.address);
        if (!resolved.ok) {
            return refusal("unready", `your key changed and ${row.address} did not serve its document to check it against: ${resolved.message}`);
        }
        // Only a document the envelope verifies under is weighed at all: a forged envelope naming a key its sender does not
        // hold changes nothing here, neither pinning a key nor holding the contact.
        if (resolved.document.fingerprint !== fromFp || !verify(resolved.document.keys)) {
            return refusal("signature", "the envelope is signed by a key your address does not serve");
        }
        const change = classifyIdentityChange({
            pinned: { address: row.address, fingerprint: row.document.fingerprint, recovery: row.document.recovery },
            next: resolved.document,
            address: row.address,
            txt: resolved.txt,
        });
        const notice = noticeOf(change);
        if (notice === "held") {
            await deps.keys.hold(row, resolved.document);
            return refusal("key_changed", `your key changed with no proof this sandbox can check: a person here must trust ${resolved.document.fingerprint} first`);
        }
        if (notice === undefined) {
            return refusal("signature", "the envelope is signed by a key your address does not vouch for");
        }
        return ok((await deps.keys.adopt(row, resolved.document, notice)).document);
    };

    const strangerSigner = strangerSignerOf(deps);

    /** Step 5: the grant a kind needs, or the call method's grant (S2S_CALLS). */
    const grantRefusal = (row: ContactRow, kind: S2sPayloadKind | S2sCallMethod): AdmitRefusal | undefined => {
        const needs = grantOf(kind);
        return needs === undefined || needs(row.grants) ? undefined : refusal("grant", `this sandbox has not granted yours ${kind.split(".")[0] ?? kind}: its owner can, on the contact`);
    };

    /** Step 5: a person-scoped contact's person on the roster here, above the floor of what is asked. */
    const floorRefusal = async (row: ContactRow, scope: PassScope | undefined): Promise<AdmitRefusal | undefined> => {
        if (row.scope.kind !== "person" || scope === undefined) {
            return undefined;
        }
        const person = (await deps.roster()).callerOf(row.scope.person);
        if (person === undefined) {
            return refusal("floor", `${row.scope.person} is not a member of this sandbox any more`);
        }
        const below = scopeRefusal(person, scope);
        return below === undefined ? undefined : refusal("floor", `${row.scope.person} may not do that here: ${below.error}`);
    };

    const steps: Steps = { contactFor, signerOf, strangerSigner, strangerBudget, grantRefusal, floorRefusal, perMinute };
    return { contactFor, signerOf, strangerSigner, grantRefusal, floorRefusal, admit: admitWith(deps, steps), limiters: { perHour, perMinute, fetches } };
};

export type S2sAdmission = ReturnType<typeof createAdmission>;

interface Steps {
    readonly contactFor: (from: string, as: string | undefined, fromFp: string, kind: string) => Promise<ContactLookup>;
    readonly signerOf: (row: ContactRow, fromFp: string, verify: (keys: S2sSigningKeys) => boolean) => Promise<Step<SandboxIdentity>>;
    readonly strangerSigner: (from: string, fromFp: string, verify: (keys: S2sSigningKeys) => boolean) => Promise<Step<SandboxIdentity>>;
    readonly strangerBudget: (from: string) => AdmitRefusal | undefined;
    readonly grantRefusal: (row: ContactRow, kind: S2sPayloadKind | S2sCallMethod) => AdmitRefusal | undefined;
    readonly floorRefusal: (row: ContactRow, scope: PassScope | undefined) => Promise<AdmitRefusal | undefined>;
    readonly perMinute: (key: string, max: number) => boolean;
}

// Step 1, past the parse the door made: an envelope to this sandbox, of a kind this build knows.
const addressed = async (deps: AdmissionDeps, envelope: S2sEnvelope): Promise<Step<S2sPayloadKind>> => {
    const identity = deps.identity();
    const [addresses, keys] = await Promise.all([identity.addresses(), identity.openWith()]);
    if (!addresses.includes(envelope.to) || !keys.some((key) => key.fingerprint === envelope.toFp)) {
        return refusal("recipient", `this sandbox is not ${envelope.to} under key ${envelope.toFp}: fetch its identity again`);
    }
    if (!isS2sPayloadKind(envelope.kind)) {
        return refusal("unknown_kind", `this sandbox does not know the kind ${envelope.kind}`);
    }
    const age = deps.now() - envelope.sentAt;
    if (age > S2S_ENVELOPE_MAX_AGE_MS) {
        return refusal("replay", "it was sealed more than a day before it arrived: an envelope is sealed afresh at every attempt, so one this old is a replay");
    }
    return -age > S2S_ENVELOPE_MAX_AHEAD_MS
        ? refusal("replay", "it was sealed more than five minutes ahead of this sandbox's clock: check the sending sandbox's clock")
        : ok(envelope.kind);
};

// Steps 5 to 7 for a contact.
const contactChecks = async (steps: Steps, row: ContactRow, envelope: S2sEnvelope, kind: S2sPayloadKind): Promise<AdmitRefusal | undefined> => {
    const refused = steps.grantRefusal(row, kind) ?? (await steps.floorRefusal(row, floorOf(kind)));
    if (refused !== undefined) {
        return refused;
    }
    if (envelope.hops > S2S_MAX_HOPS) {
        return refusal("hops", `it crossed ${envelope.hops} sandboxes, past the ${S2S_MAX_HOPS} allowed`);
    }
    const bucket = minuteOf(kind);
    return steps.perMinute(`${row.id}\u0000${bucket}`, S2S_PER_MINUTE[bucket])
        ? refusal("rate", `at most ${S2S_PER_MINUTE[bucket]} ${bucket} envelopes a minute from one contact`)
        : undefined;
};

// Step 8 for a contact: opened with this sandbox's keys.
const opened = async (deps: AdmissionDeps, envelope: S2sEnvelope, sender: SandboxIdentity, row: ContactRow): Promise<Admission> => {
    const open = openEnvelope(envelope, { sender: sender.keys, keys: await deps.identity().openWith() });
    if (!open.ok) {
        return open.reason === "recipient" ? refusal("recipient", "it is sealed to no key this sandbox holds") : refusal("malformed", `the body does not open (${open.reason})`);
    }
    return { kind: "admitted", received: { envelope, header: open.header, payload: open.payload, contact: row, sender, receivedAt: deps.now() } };
};

// A stranger's request, cheapest and self-contained checks first: it opens and verifies against the document it embeds
// before anything is spent on it, and only then is its address asked for its document.
const strangerAdmitted = async (deps: AdmissionDeps, steps: Steps, envelope: S2sEnvelope, kind: S2sPayloadKind): Promise<Admission> => {
    const open = openSelfSigned(envelope, await deps.identity().openWith(), (payload) =>
        payload.kind === "contact.request" && payload.document.fingerprint === envelope.fromFp && verifyIdentity(payload.document).ok ? payload.document.keys : undefined,
    );
    if (!open.ok) {
        return strangerOpenRefusal(open.reason);
    }
    if (deps.kinds.handlerOf(kind) === undefined) {
        return refusal("unready", `this sandbox takes no ${kind} yet: try again later`);
    }
    const spent = steps.strangerBudget(envelope.from);
    if (spent !== undefined) {
        return spent;
    }
    const sender = await steps.strangerSigner(envelope.from, envelope.fromFp, (keys) => verifyEnvelope(envelope, keys));
    if (sender.kind === "refused") {
        return sender;
    }
    return { kind: "admitted", received: { envelope, header: open.header, payload: open.payload, contact: undefined, sender: sender.value, receivedAt: deps.now() } };
};

const admitWith =
    (deps: AdmissionDeps, steps: Steps) =>
    async (envelope: S2sEnvelope): Promise<Admission> => {
        const known = await addressed(deps, envelope);
        if (known.kind === "refused") {
            return known;
        }
        if (await deps.seen.has(envelope.id)) {
            return { kind: "duplicate", id: envelope.id };
        }
        const kind = known.value;
        const lookup = await steps.contactFor(envelope.from, envelope.as, envelope.fromFp, kind);
        if (lookup.kind === "blocked") {
            return { kind: "swallowed", id: envelope.id };
        }
        if (lookup.kind === "refused") {
            return lookup;
        }
        if (lookup.kind === "stranger") {
            return strangerAdmitted(deps, steps, envelope, kind);
        }
        const { row } = lookup;
        const sender = await steps.signerOf(row, envelope.fromFp, (keys) => verifyEnvelope(envelope, keys));
        if (sender.kind === "refused") {
            return sender;
        }
        const refused = await contactChecks(steps, row, envelope, kind);
        if (refused !== undefined) {
            return refused;
        }
        if (deps.kinds.handlerOf(kind) === undefined) {
            return refusal("unready", `this sandbox takes no ${kind} yet: try again later`);
        }
        return opened(deps, envelope, sender.value, row);
    };
