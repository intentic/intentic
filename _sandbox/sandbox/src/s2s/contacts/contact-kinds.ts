import { keyedLock } from "@intentic/base/async";
import { classifyIdentityChange } from "@intentic/sandbox-contract/s2s";
import { type S2sContactNotice, S2sGrantsSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { opt } from "../../opt.js";
import type { S2sHearing } from "../heard.js";
import type { S2sKindOutcome, S2sKinds, S2sReceived } from "../messages/kinds.js";
import { cleared, type ContactsCore, keyChangesOf, rotatedDocumentProblem, sameKeyDocumentProblem, sendAccept } from "./contacts.js";
import type { ContactRow } from "./contacts-store.js";

// THE HANDSHAKE'S KINDS, received (docs/architecture/messages.md, "Two ways to make one" and "Rotation and recovery"):
// - contact.request from a stranger files it `pending-in` for a person (admission already confirmed its document against
//   its address) and tells automations; from a contact already asked, the two asked each other, so it is accepted; from
//   an accepted contact that forgot this sandbox, the accept is sent again; from one that removed this sandbox, it waits
//   on a person again;
// - contact.accept makes an asked contact accepted and lets what waited for it go;
// - contact.update carries changed grants and the contact's wake secret, or its withdrawal;
// - contact.remove marks that the far side let this sandbox go;
// - identity.rotated: admission already pinned the vouched key the envelope was signed with; a document newer still is
//   weighed by the rotation table here.
// A document a contact sends about itself replaces the pinned one only when it verifies, names the same sandbox and still
// the address the contact is filed under, and keeps its pinned recovery key (contacts.ts sameKeyDocumentProblem); else the
// pinned one stays. A stranger's requests are taken one at a time per address, so two racing make one contact.

const STORED = { stored: true } as const;

const removedNotice = (at: number): S2sContactNotice => ({ kind: "removed", at, seen: false });

// A stranger's request: a contact waiting on a person, with what it said and the wake secret it gave.
const fileRequest = async (core: ContactsCore, received: S2sReceived<"contact.request">, heard: S2sHearing): Promise<S2sKindOutcome> => {
    const { payload, header } = received;
    if (payload.scope.kind !== "sandbox") {
        return { refused: "grant", error: "a person's own route between two sandboxes is made by pairing, signed in to both: not by request" };
    }
    const row = await core.deps.store.put(
        core.newRow({
            address: header.from,
            document: received.sender,
            scope: { kind: "sandbox" },
            state: "pending-in",
            grants: S2sGrantsSchema.parse({}),
            theirGrants: payload.grants,
            origin: "request",
            ...opt("note", payload.note),
            lastSeenAt: received.receivedAt,
        }),
    );
    await core.deps.secrets.setTheirs(row.id, payload.wake);
    return { stored: true, after: async () => heard({ event: "contact.request", contact: row, envelope: header.id, note: payload.note, at: received.receivedAt }) };
};

// A request from a contact this sandbox already has a row for.
const knownRequest = async (core: ContactsCore, row: ContactRow, received: S2sReceived<"contact.request">, heard: S2sHearing): Promise<S2sKindOutcome> => {
    const { payload } = received;
    await core.deps.secrets.setTheirs(row.id, payload.wake);
    const forgotten = row.state === "accepted" && !row.notices.some((notice) => notice.kind === "removed");
    if (row.state === "pending-out" || forgotten) {
        const accepted = await core.deps.store.put(core.touch(cleared(row, ["note"]), { state: "accepted", theirGrants: payload.grants, document: received.sender }));
        await sendAccept(core, accepted);
        await core.deps.outbox.kickContact(row.id);
        return STORED;
    }
    const waiting = await core.deps.store.put(
        core.touch(row, { state: "pending-in", theirGrants: payload.grants, document: received.sender, notices: row.notices.filter((notice) => notice.kind !== "removed"), ...opt("note", payload.note) }),
    );
    return { stored: true, after: async () => heard({ event: "contact.request", contact: waiting, envelope: received.header.id, note: payload.note, at: received.receivedAt }) };
};

// The document a contact sent about itself, where it may replace the one admission verified the envelope under.
const ownWord = (core: ContactsCore, row: ContactRow, pinned: ContactRow["document"], sent: ContactRow["document"]): ContactRow["document"] => {
    const problem = sameKeyDocumentProblem({ address: row.address, document: pinned }, sent);
    if (problem !== undefined && sent !== pinned) {
        core.deps.logger.warn({ contact: row.id, problem }, "s2s contacts: a document a contact sent was not pinned");
    }
    return problem === undefined ? sent : pinned;
};

const accept = async (core: ContactsCore, row: ContactRow, received: S2sReceived<"contact.accept">): Promise<S2sKindOutcome> => {
    const { payload } = received;
    const document = ownWord(core, row, received.sender, payload.document);
    await core.deps.store.put(core.touch(cleared(row, ["note"]), { state: "accepted", theirGrants: payload.grants, document }));
    await core.deps.secrets.setTheirs(row.id, payload.wake);
    return { stored: true, after: async () => core.deps.outbox.kickContact(row.id) };
};

const update = async (core: ContactsCore, row: ContactRow, received: S2sReceived<"contact.update">): Promise<S2sKindOutcome> => {
    const { payload } = received;
    if (payload.grants !== undefined) {
        await core.deps.store.change(row.id, (held) => core.touch(held, { theirGrants: payload.grants }));
    }
    if (payload.wake !== undefined) {
        await core.deps.secrets.setTheirs(row.id, payload.wake ?? undefined);
    }
    return STORED;
};

const remove = async (core: ContactsCore, row: ContactRow): Promise<S2sKindOutcome> => {
    await core.deps.store.change(row.id, (held) => {
        const { theirGrants: _theirs, ...rest } = held;
        return core.touch(rest, { notices: [...held.notices, removedNotice(core.deps.now())] });
    });
    await core.deps.secrets.setTheirs(row.id, undefined);
    return STORED;
};

// A rotation notice whose document is newer than the key the envelope was signed with: weighed by the rotation table.
const rotated = async (core: ContactsCore, row: ContactRow, received: S2sReceived<"identity.rotated">): Promise<S2sKindOutcome> => {
    const { document } = received.payload;
    const pinned = received.sender;
    if (document.fingerprint === pinned.fingerprint) {
        const kept = ownWord(core, row, pinned, document);
        if (kept === document) {
            await core.deps.store.change(row.id, (held) => core.touch(held, { document }));
        }
        return STORED;
    }
    const change = classifyIdentityChange({ pinned: { address: row.address, fingerprint: pinned.fingerprint, recovery: pinned.recovery }, next: document, address: row.address });
    if ((change.kind === "rotated" || change.kind === "recovered") && rotatedDocumentProblem({ address: row.address, document: pinned }, document) === undefined) {
        await keyChangesOf(core).adopt({ ...row, document: pinned }, document, change.kind);
    }
    return STORED;
};

// Each kind handled only for a contact; a stranger reaches only contact.request (admission says so).
const forContact =
    <K extends "contact.accept" | "contact.update" | "contact.remove" | "identity.rotated">(handle: (row: ContactRow, received: S2sReceived<K>) => Promise<S2sKindOutcome>) =>
    async (received: S2sReceived<K>): Promise<S2sKindOutcome> =>
        received.contact === undefined ? { refused: "not_contact", error: "only a contact sends this" } : handle(received.contact, received);

/** Registers the handshake's kinds and the rotation notice with the inbox. */
export const registerContactKinds = (core: ContactsCore, kinds: Pick<S2sKinds, "register">, heard: S2sHearing): void => {
    const strangers = keyedLock<string>();
    // A stranger's request, filed once per address: one racing it in found no row, so it looks again under the lock.
    const fromStranger = async (received: S2sReceived<"contact.request">): Promise<S2sKindOutcome> =>
        strangers(received.header.from, async () => {
            const filed = await core.deps.store.find(received.header.from, { kind: "sandbox" });
            if (filed === undefined) {
                return fileRequest(core, received, heard);
            }
            return filed.document.fingerprint === received.sender.fingerprint
                ? knownRequest(core, filed, received, heard)
                : { refused: "unready", error: "another request from this address is being filed under another key: ask again shortly" };
        });
    kinds.register("contact.request", async (received) => (received.contact === undefined ? fromStranger(received) : knownRequest(core, received.contact, received, heard)));
    kinds.register("contact.accept", forContact((row, received) => accept(core, row, received)));
    kinds.register("contact.update", forContact((row, received) => update(core, row, received)));
    kinds.register("contact.remove", forContact((row) => remove(core, row)));
    kinds.register("identity.rotated", forContact((row, received) => rotated(core, row, received)));
};
