import { type RandomBytes, uuidv7 } from "@intentic/sandbox-contract/s2s";
import {
    attestationText,
    S2S_ATTESTATION_VALID_MAX_MS,
    type S2sAttestationAccept,
    type S2sAttestationAsk,
    type S2sAttestationIssue,
    type S2sAttestations,
    type S2sMessageSendOutcome,
    type S2sPayloadOf,
} from "@intentic/sandbox-contract/schemas/s2s";
import { opt } from "../../opt.js";
import type { ContactRow, ContactsStore } from "../contacts/contacts-store.js";
import { type IdentityRefusal, isIdentityRefusal, type S2sIdentity } from "../identity/s2s-identity.js";
import type { S2sOutbox } from "../messages/outbox.js";
import type { NewMessage, ThreadsStore } from "../messages/threads-store.js";

// ATTESTATIONS, sent and taken (docs/architecture/messages.md, "Attestations"), each a person's press on the Messages tab,
// the owner's or a maintainer's (RAW_ROUTES; no agent token reaches them): asking a contact to vouch for this sandbox,
// vouching for a contact (a `sandbox-vouch` signed now by this sandbox's key for the key the contact is pinned under), and
// adding a vouch a contact sent to this sandbox's identity. Each send is filed in the contact's thread at once, `queued`,
// and goes through the one outbox, as a message does (messages/send-message.ts).

export interface AttestationDeps {
    readonly contacts: Pick<ContactsStore, "get">;
    readonly threads: ThreadsStore;
    readonly outbox: Pick<S2sOutbox, "enqueue">;
    readonly identity: () => S2sIdentity;
    readonly now: () => number;
    readonly random?: RandomBytes;
}

export interface AttestationRefusal {
    readonly error: string;
    readonly status: 400 | 404 | 409;
}

type Sendable = S2sPayloadOf<"attestation.request"> | S2sPayloadOf<"attestation.issued">;

// The contact a person may ask or vouch for: one this sandbox holds, sandbox-scoped and accepted.
const sandboxContact = async (deps: AttestationDeps, id: string): Promise<ContactRow | AttestationRefusal> => {
    const row = await deps.contacts.get(id);
    if (row === undefined || row.scope.kind !== "sandbox") {
        return { error: `no sandbox contact ${id.slice(0, 100)} here: a person's own route carries no attestations`, status: 404 };
    }
    return row.state === "accepted" ? row : { error: `${row.address} is ${row.state} here: an attestation goes to an accepted contact`, status: 409 };
};

// The thread an answer goes into: the one holding the message it answers, when that is this contact's.
const threadOf = async (deps: AttestationDeps, row: ContactRow, replyTo: string | undefined): Promise<string | undefined> => {
    const thread = replyTo === undefined ? undefined : await deps.threads.ofMessage(replyTo);
    return thread?.contact === row.id ? thread.id : undefined;
};

// Files the send in the contact's thread, `queued`, and hands it to the outbox.
const send = async (deps: AttestationDeps, row: ContactRow, payload: Sendable, extra: Pick<NewMessage, "claims" | "attestation">, replyTo: string | undefined): Promise<S2sMessageSendOutcome> => {
    const sentAt = deps.now();
    const id = uuidv7(sentAt, deps.random);
    const claims = payload.kind === "attestation.request" ? payload.claims : (extra.claims ?? {});
    const message: NewMessage = {
        id,
        direction: "out",
        kind: payload.kind,
        text: attestationText(claims, payload.note),
        attachments: [],
        ...opt("replyTo", replyTo),
        ...extra,
        sentAt,
        read: true,
        delivery: { state: "queued", attempts: 0 },
    };
    const filed = await deps.threads.file({ contact: row.id, thread: await threadOf(deps, row, replyTo) }, message, []);
    if (filed.kind !== "filed") {
        return { state: "refused", reason: filed.reason };
    }
    const queued = await deps.outbox.enqueue({ id, contact: row, payload, thread: filed.wire, replyTo });
    if ("refused" in queued) {
        await deps.threads.changeMessage(filed.thread, id, (held) => ({ ...held, delivery: { state: "undelivered", attempts: 0, reason: queued.refused } }));
        return { state: "refused", reason: queued.refused };
    }
    return { state: "queued", id, thread: filed.thread };
};

/** Asks a contact to vouch for this sandbox: an `attestation.request` with the claims hoped for. */
export const askForVouch = async (deps: AttestationDeps, input: S2sAttestationAsk): Promise<S2sMessageSendOutcome | AttestationRefusal> => {
    const row = await sandboxContact(deps, input.contact);
    if ("error" in row) {
        return row;
    }
    return send(deps, row, { kind: "attestation.request", claims: input.claims, ...opt("note", input.note) }, { claims: input.claims }, undefined);
};

/** Vouches for a contact: signed now for the key it is pinned under, filed in its thread and sent (`attestation.issued`). */
export const vouchForContact = async (deps: AttestationDeps, input: S2sAttestationIssue): Promise<S2sMessageSendOutcome | AttestationRefusal> => {
    const row = await sandboxContact(deps, input.contact);
    if ("error" in row) {
        return row;
    }
    const now = deps.now();
    if (input.validUntil <= now || input.validUntil - now > S2S_ATTESTATION_VALID_MAX_MS) {
        return { error: "a vouch is valid from now for at most a year: pick a later date within that", status: 400 };
    }
    const subject = { sandbox: row.document.sandbox, address: row.address, fingerprint: row.document.fingerprint };
    const vouch = await deps.identity().issueVouch(subject, input.claims, input.validUntil);
    if (isIdentityRefusal(vouch)) {
        return { error: vouch.refused, status: vouch.status };
    }
    return send(deps, row, { kind: "attestation.issued", attestation: vouch, ...opt("note", input.note) }, { claims: input.claims, attestation: vouch }, input.replyTo);
};

/** Adds the vouch a contact's `attestation.issued` message carried to this sandbox's identity, once it verifies. */
export const acceptVouch = async (deps: AttestationDeps, input: S2sAttestationAccept): Promise<S2sAttestations | IdentityRefusal> => {
    const thread = await deps.threads.ofMessage(input.message);
    const message = thread?.messages.find((held) => held.id === input.message);
    if (thread === undefined || message?.direction !== "in" || message.kind !== "attestation.issued" || message.attestation === undefined) {
        return { refused: `no attestation a contact sent is filed as message ${input.message}`, status: 404 };
    }
    const row = await deps.contacts.get(thread.contact);
    if (row?.scope.kind !== "sandbox" || row.state === "blocked") {
        return { refused: "the contact that sent it is no sandbox contact here any more", status: 409 };
    }
    return deps.identity().addAttestation(message.attestation, { contact: row.id, message: message.id });
};
