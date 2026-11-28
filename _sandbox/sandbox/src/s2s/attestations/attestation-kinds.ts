import { sandboxVouchOf, verifyAttestation } from "@intentic/sandbox-contract/s2s";
import { attestationText } from "@intentic/sandbox-contract/schemas/s2s";
import { opt } from "../../opt.js";
import type { ContactRow } from "../contacts/contacts-store.js";
import type { S2sIdentity } from "../identity/s2s-identity.js";
import type { S2sKindOutcome, S2sKinds, S2sReceived } from "../messages/kinds.js";
import type { NewMessage, ThreadsStore } from "../messages/threads-store.js";

// ATTESTATIONS, received (docs/architecture/messages.md, "Attestations"): a contact asking this sandbox to vouch for it
// (`attestation.request`), and a contact's signed vouch for this sandbox (`attestation.issued`). Neither is acted on when
// it arrives, by an automation or anything else: each is filed unread in the contact's thread, where a person here issues
// a vouch for the request or adds the vouch to this sandbox's identity (attestations.ts), or leaves it. Both are the
// sandbox speaking as itself, so a person-scoped contact sends neither. A vouch is checked as it arrives (its issuer is
// the sender, and it verifies against this sandbox's document), so its sender hears at once why one cannot be taken.

type Kind = "attestation.request" | "attestation.issued";

// The message as the thread files it, received and unread.
const incoming = ({ header, receivedAt }: Pick<S2sReceived, "header" | "receivedAt">, kind: Kind, text: string): NewMessage => ({
    id: header.id,
    direction: "in",
    kind,
    text,
    attachments: [],
    ...opt("replyTo", header.replyTo),
    sentAt: header.sentAt,
    receivedAt,
    read: false,
});

const fileInThread = async (threads: ThreadsStore, row: ContactRow, { header }: Pick<S2sReceived, "header">, message: NewMessage): Promise<S2sKindOutcome> => {
    const filed = await threads.file({ contact: row.id, wire: header.thread ?? header.id }, message, []);
    if (filed.kind !== "filed") {
        return filed.kind === "full" ? { refused: "rate", error: filed.reason } : { refused: "malformed", error: filed.reason };
    }
    return { stored: true };
};

// Who may send one: an accepted, sandbox-scoped contact. Undefined when this one may.
const senderRefusal = (row: ContactRow | undefined): S2sKindOutcome | undefined => {
    if (row === undefined) {
        return { refused: "not_contact", error: "only a contact asks for or sends an attestation" };
    }
    return row.scope.kind === "sandbox" ? undefined : { refused: "grant", error: "an attestation is a sandbox speaking as itself: it goes between sandbox-scoped contacts only" };
};

const request = async (threads: ThreadsStore, received: S2sReceived<"attestation.request">): Promise<S2sKindOutcome> => {
    const row = received.contact;
    const refused = senderRefusal(row);
    if (refused !== undefined || row === undefined) {
        return refused ?? { refused: "not_contact", error: "no contact" };
    }
    const { claims, note } = received.payload;
    return fileInThread(threads, row, received, { ...incoming(received, "attestation.request", attestationText(claims, note)), claims });
};

// Why a vouch cannot be taken as it arrives, or undefined: one this build reads, signed by the sender (under its pinned key
// or the one its `prev` names), that verifies against this sandbox's document now.
const issuedProblem = async (identity: () => S2sIdentity, received: S2sReceived<"attestation.issued">): Promise<string | undefined> => {
    const vouch = sandboxVouchOf(received.payload.attestation);
    if (vouch === undefined) {
        return "this sandbox reads sandbox-vouch attestations only";
    }
    const { sender } = received;
    const senderKeys = sender.prev?.by === "key" ? [sender.fingerprint, sender.prev.fingerprint] : [sender.fingerprint];
    if (!senderKeys.includes(vouch.issuer.fingerprint)) {
        return "an attestation is sent by the sandbox that signed it";
    }
    const check = verifyAttestation(vouch, await identity().document(), { now: received.receivedAt });
    return check.ok ? undefined : `it does not verify against this sandbox's identity: ${check.reason}`;
};

const issued = async (threads: ThreadsStore, identity: () => S2sIdentity, received: S2sReceived<"attestation.issued">): Promise<S2sKindOutcome> => {
    const row = received.contact;
    const refused = senderRefusal(row);
    if (refused !== undefined || row === undefined) {
        return refused ?? { refused: "not_contact", error: "no contact" };
    }
    const problem = await issuedProblem(identity, received);
    if (problem !== undefined) {
        return { refused: "malformed", error: problem };
    }
    const { attestation, note } = received.payload;
    const claims = sandboxVouchOf(attestation)?.claims ?? {};
    return fileInThread(threads, row, received, { ...incoming(received, "attestation.issued", attestationText(claims, note)), attestation });
};

/** Registers `attestation.request` and `attestation.issued` with the inbox. */
export const registerAttestationKinds = (threads: ThreadsStore, kinds: Pick<S2sKinds, "register">, identity: () => S2sIdentity): void => {
    kinds.register("attestation.request", async (received) => request(threads, received));
    kinds.register("attestation.issued", async (received) => issued(threads, identity, received));
};
