import { randomUUID } from "node:crypto";
import { normalizeAddress, type ResolvedAddress, type ResolveRefusal, verifyIdentity } from "@intentic/sandbox-contract/s2s";
import {
    S2sGrantsSchema,
    type S2sContactAdd,
    type S2sContactChange,
    type S2sContactNoticeKind,
    type S2sContactScope,
    type S2sGrants,
    type S2sPayload,
    type SandboxIdentity,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import type { KeyChanges } from "../admission.js";
import type { S2sIdentity } from "../identity/s2s-identity.js";
import type { S2sOutbox } from "../messages/outbox.js";
import { grantsAfter, grantsFor, sameGrants } from "./contact-view.js";
import type { ContactRow, ContactsStore } from "./contacts-store.js";
import type { WakeSecrets } from "./s2s-secrets.js";

// WHAT A PERSON DOES TO A CONTACT (docs/architecture/messages.md, "Contacts"): the handshake's first half (add), accepting
// a request, blocking, removing, changing grants or a name, and trusting a key that changed with no proof; and what
// admission does when a key changes (KeyChanges). Every change the far side should know of goes through the one outbox
// as a `contact.*` message. One wake secret serves every contact granted `wake`, so a contact that was ever handed it
// (`wakeHeld`, in any state) and leaves (removed, blocked, its grant withdrawn, its person off the roster) replaces the
// secret, and the new one goes to the rest.

// A refusal, with the status its route answers.
export interface ContactRefusal {
    readonly refused: string;
    readonly status: 400 | 403 | 404 | 409 | 502;
}

export const isContactRefusal = <T extends object>(value: T | ContactRefusal): value is ContactRefusal => "refused" in value;

export interface ContactsDeps {
    readonly store: ContactsStore;
    readonly secrets: WakeSecrets;
    readonly outbox: Pick<S2sOutbox, "enqueue" | "kickContact">;
    readonly identity: () => Pick<S2sIdentity, "document">;
    readonly resolve: (address: string) => Promise<ResolvedAddress>;
    readonly now: () => number;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly newId?: () => string;
    // The platform's zone, under which a sandbox's host vouches for its id (contacts-store.ts vouchedSandboxOf).
    readonly zone?: string | undefined;
    // Who is on the roster now: a person-scoped contact whose person left gives back the wake secret it held.
    readonly roster?: () => Promise<{ readonly callerOf: (email: string) => object | undefined }>;
}

const notFound = (id: string): ContactRefusal => ({ refused: `no contact ${id} here`, status: 404 });

// The status an address that did not resolve answers: a typo is the asker's, an old daemon a conflict, the rest the far side's.
const resolveStatus = (code: ResolveRefusal): ContactRefusal["status"] => {
    switch (code) {
        case "invalid_address":
            return 400;
        case "too_old":
        case "txt":
            return 409;
        default:
            return 502;
    }
};

/** The row without the fields named: a request's note once answered, a key no longer waiting. */
export const cleared = (row: ContactRow, keys: readonly ("note" | "pending" | "heldFrom")[]): ContactRow => {
    const copy = { ...row };
    for (const key of keys) {
        delete copy[key];
    }
    return copy;
};

// Whether a payload hands the contact this sandbox's wake secret: a request or an accept to a contact granted `wake` (the
// outbox fills the secret in when it seals), or an update carrying it.
const handsWake = (row: ContactRow, payload: S2sPayload): boolean =>
    payload.kind === "contact.update" ? payload.wake !== undefined && payload.wake !== null : (payload.kind === "contact.request" || payload.kind === "contact.accept") && row.grants.wake;

export const createContactsCore = (deps: ContactsDeps) => {
    const newId = deps.newId ?? ((): string => `c-${randomUUID().replaceAll("-", "").slice(0, 16)}`);

    const touch = (row: ContactRow, change: Partial<ContactRow>): ContactRow => ({ ...row, ...change, updatedAt: deps.now() });

    /** Marks a contact as handed the inbound wake secret, so its leaving replaces it. */
    const handedWake = async (id: string): Promise<void> => {
        await deps.store.change(id, (held) => (held.wakeHeld === true ? undefined : { ...held, wakeHeld: true }));
    };

    const send = async (row: ContactRow, payload: S2sPayload): Promise<void> => {
        if (handsWake(row, payload)) {
            await handedWake(row.id);
        }
        const queued = await deps.outbox.enqueue({ contact: row, payload });
        if ("refused" in queued) {
            deps.logger.warn({ contact: row.id, kind: payload.kind, reason: queued.refused }, "s2s contacts: a contact message was not queued");
        }
    };

    // Whether a contact still stands to hold the secret: the sandbox's own, or a person's still on the roster.
    const standing = async (): Promise<(row: ContactRow) => boolean> => {
        const roster = await deps.roster?.();
        return (row) => row.scope.kind === "sandbox" || roster === undefined || roster.callerOf(row.scope.person) !== undefined;
    };

    // A new wake secret in place of the one contacts that held it took away, handed to every contact still granted `wake`
    // that may hear it (one whose key is held hears it once a person trusts the key). The leavers hold it no more.
    const rewake = async (leaving: readonly string[]): Promise<void> => {
        const secret = await deps.secrets.rotateInbound();
        for (const id of leaving) {
            await deps.store.change(id, (held) => {
                const { wakeHeld: _held, ...rest } = held;
                return held.wakeHeld === true ? rest : undefined;
            });
        }
        const stands = await standing();
        for (const row of await deps.store.list()) {
            if (!leaving.includes(row.id) && row.grants.wake && (row.state === "accepted" || row.state === "key-changed") && stands(row)) {
                await send(row, { kind: "contact.update", wake: secret });
            }
        }
    };

    /** Person-scoped contacts handed the secret whose person is off the roster now: the secret replaced once for them all. */
    const sweepLeavers = async (): Promise<void> => {
        const stands = await standing();
        const gone = (await deps.store.list()).filter((row) => row.wakeHeld === true && !stands(row)).map((row) => row.id);
        if (gone.length > 0) {
            await rewake(gone);
        }
    };

    /** The secret replaced when a contact that was handed it leaves, whatever state it was in. */
    const leaving = async (before: ContactRow): Promise<void> => {
        if (before.wakeHeld === true) {
            await rewake([before.id]);
        }
    };

    const newRow = (fields: Pick<ContactRow, "address" | "document" | "scope" | "state" | "grants" | "origin"> & Partial<ContactRow>): ContactRow => {
        const at = deps.now();
        return { id: newId(), notices: [], createdAt: at, updatedAt: at, ...fields, grants: grantsFor(fields.grants, fields.scope) };
    };

    return { deps, send, touch, rewake, leaving, sweepLeavers, handedWake, newRow };
};

export type ContactsCore = ReturnType<typeof createContactsCore>;

const ourDocument = async (core: ContactsCore): Promise<SandboxIdentity> => core.deps.identity().document();

/** Sends the accept: what this sandbox grants it, its document and wake secret filled in when the outbox seals it. */
export const sendAccept = async (core: ContactsCore, row: ContactRow): Promise<void> =>
    core.send(row, { kind: "contact.accept", document: await ourDocument(core), grants: row.grants });

// The handshake's first half (POST /s2s/contacts): resolve the address, pin its key provisionally, and ask.
export const addContact = async (core: ContactsCore, input: S2sContactAdd): Promise<ContactRow | ContactRefusal> => {
    const resolved = await core.deps.resolve(input.address);
    if (!resolved.ok) {
        return { refused: resolved.message, status: resolveStatus(resolved.code) };
    }
    const ours = await ourDocument(core);
    if (resolved.document.fingerprint === ours.fingerprint || resolved.host === ours.host) {
        return { refused: `${resolved.address} is this sandbox`, status: 400 };
    }
    const scope: S2sContactScope = { kind: "sandbox" };
    const held = await core.deps.store.find(resolved.address, scope);
    if (held?.state === "accepted" || held?.state === "blocked" || held?.state === "key-changed") {
        return { refused: `${resolved.address} is already a contact here (${held.state})`, status: 409 };
    }
    if (held?.state === "pending-in") {
        // It asked first: adding it is accepting it.
        return acceptContact(core, held.id, input.grants);
    }
    const row = await core.deps.store.put(
        held === undefined
            ? core.newRow({ address: resolved.address, document: resolved.document, scope, state: "pending-out", grants: input.grants, origin: "request", ...opt("note", input.note) })
            : core.touch(held, { document: resolved.document, grants: grantsFor(input.grants, scope), ...opt("note", input.note) }),
    );
    await core.send(row, { kind: "contact.request", document: ours, grants: row.grants, scope, ...opt("note", input.note) });
    return row;
};

// A request waiting on a person, accepted with the grants they chose (messages only by default).
export const acceptContact = async (core: ContactsCore, id: string, grants: S2sGrants): Promise<ContactRow | ContactRefusal> => {
    const row = await core.deps.store.change(id, (held) =>
        held.state === "pending-in" ? core.touch(cleared(held, ["note"]), { state: "accepted", grants: grantsFor(grants, held.scope) }) : undefined,
    );
    if (row === undefined) {
        return (await core.deps.store.get(id)) === undefined ? notFound(id) : { refused: "only a request waiting on a person here can be accepted", status: 409 };
    }
    await sendAccept(core, row);
    await core.deps.outbox.kickContact(row.id);
    return row;
};

// Blocked: nothing it sends is kept, and it is never told (a block is not a signal).
export const blockContact = async (core: ContactsCore, id: string): Promise<ContactRow | ContactRefusal> => {
    const before = await core.deps.store.get(id);
    const row = await core.deps.store.change(id, (held) => core.touch(cleared(held, ["note", "pending"]), { state: "blocked" }));
    if (before === undefined || row === undefined) {
        return notFound(id);
    }
    await core.deps.secrets.setTheirs(id, undefined);
    await core.leaving(before);
    return row;
};

// Removed here, and told so; its wake secret replaced when it held it.
export const removeContact = async (core: ContactsCore, id: string): Promise<ContactRow | ContactRefusal> => {
    const row = await core.deps.store.get(id);
    if (row === undefined) {
        return notFound(id);
    }
    if (row.state !== "blocked") {
        await core.send(row, { kind: "contact.remove" });
    }
    await core.deps.store.remove(id);
    await core.deps.secrets.setTheirs(id, undefined);
    await core.leaving(row);
    return row;
};

// A name of this sandbox's own for it, and changed grants, which it is told of (with the wake secret, or its withdrawal).
export const changeContact = async (core: ContactsCore, id: string, input: S2sContactChange): Promise<ContactRow | ContactRefusal> => {
    const before = await core.deps.store.get(id);
    if (before === undefined) {
        return notFound(id);
    }
    const grants = input.grants === undefined ? before.grants : grantsFor(S2sGrantsSchema.parse(grantsAfter(before.grants, input.grants)), before.scope);
    const row = await core.deps.store.put(core.touch(before, { grants, ...opt("name", input.name) }));
    if (sameGrants(before.grants, grants) || row.state === "blocked") {
        return row;
    }
    const wake = grants.wake === before.grants.wake ? undefined : grants.wake ? await core.deps.secrets.inbound() : null;
    await core.send(row, { kind: "contact.update", grants, ...opt("wake", wake) });
    if (wake === null) {
        await core.leaving(before);
    }
    return row;
};

// Trust new key: the fingerprint the person compared must be the one waiting. The contact goes back to the state it had
// when its key changed: a request still waits on a person, an ask still waits for the accept.
export const trustKey = async (core: ContactsCore, id: string, fingerprint: string): Promise<ContactRow | ContactRefusal> => {
    const row = await core.deps.store.change(id, (held) =>
        held.state === "key-changed" && held.pending?.fingerprint === fingerprint
            ? core.touch(cleared(held, ["pending", "heldFrom"]), { state: held.heldFrom ?? "accepted", document: held.pending })
            : undefined,
    );
    if (row === undefined) {
        const held = await core.deps.store.get(id);
        return held === undefined
            ? notFound(id)
            : { refused: held.pending === undefined ? `${held.address}'s key has not changed` : `the key waiting is ${held.pending.fingerprint}, not ${fingerprint}`, status: 409 };
    }
    await core.deps.outbox.kickContact(row.id);
    return row;
};

/** What admission does when a contact's key changed: pin a vouched document with its notice, or hold the contact. */
export const keyChangesOf = (core: ContactsCore): KeyChanges => ({
    adopt: async (row, document, notice: S2sContactNoticeKind) =>
        (await core.deps.store.change(row.id, (held) =>
            core.touch(cleared(held, ["pending"]), {
                document,
                notices: [...held.notices, { kind: notice, at: core.deps.now(), from: held.document.fingerprint, to: document.fingerprint, seen: false }],
            }),
        )) ?? row,
    hold: async (row, document) => {
        await core.deps.store.change(row.id, (held) =>
            core.touch(held, {
                state: "key-changed",
                pending: document,
                ...opt("heldFrom", held.state === "key-changed" || held.state === "blocked" ? held.heldFrom : held.state),
            }),
        );
        core.deps.logger.warn({ contact: row.id, address: row.address, from: row.document.fingerprint, to: document.fingerprint }, "s2s contacts: a key changed with no proof");
    },
});

/**
 * Why a document a contact sent about itself under its pinned key may not replace the one pinned, or undefined when it may:
 * it must verify, carry the pinned key, name the same sandbox, still name the address the contact is filed under (its
 * host or one of its domains), and keep the recovery key pinned: a contact adds a recovery key where none was pinned, and
 * changes one only by a rotation the rules accept (keyChangesOf, the rotation table).
 */
export const sameKeyDocumentProblem = (row: Pick<ContactRow, "address" | "document">, next: SandboxIdentity): string | undefined => {
    const check = verifyIdentity(next);
    if (!check.ok) {
        return `it does not verify: ${check.reason}`;
    }
    if (next.fingerprint !== row.document.fingerprint) {
        return "it carries another key than the one pinned";
    }
    return rotatedDocumentProblem(row, next) ?? (row.document.recovery !== undefined && next.recovery !== row.document.recovery ? "it changes the recovery key pinned for it" : undefined);
};

/** Why a new key's document, one the rotation table accepts, still may not be pinned: another sandbox, or another address. */
export const rotatedDocumentProblem = (row: Pick<ContactRow, "address" | "document">, next: SandboxIdentity): string | undefined => {
    if (next.sandbox !== row.document.sandbox) {
        return `it names another sandbox (${next.sandbox.slice(0, 100)})`;
    }
    return normalizeAddress(next.host) === row.address || next.domains.includes(row.address) ? undefined : `it no longer names ${row.address}, the address it is filed under`;
};
