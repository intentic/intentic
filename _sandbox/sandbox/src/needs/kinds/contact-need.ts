import { normalizeAddress } from "@intentic/sandbox-contract/s2s";
import type { NeedAsk, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import { type ContactNeed, type S2sContactAdd, type S2sGrants, S2sGrantsSchema } from "@intentic/sandbox-contract/schemas/s2s";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { sameGrants } from "../../s2s/contacts/contact-view.js";
import { acceptContact, addContact, type ContactRefusal, isContactRefusal } from "../../s2s/contacts/contacts.js";
import type { ContactRow } from "../../s2s/contacts/contacts-store.js";
import type { Answered, AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// Another sandbox added or accepted as a contact (docs/architecture/messages.md, "Contacts"): an agent never makes or
// accepts one itself, so `messages contacts add|accept` raises this card and a person's press carries it out, the
// handshake's request or the accept, under the grants the card shows. One exception, the owner's to make: with
// `contacts.agentMayAccept` on, an automation's turn accepts a waiting request itself when it gives messages only.

export interface ContactNeedDeps {
    readonly contact: (id: string) => Promise<ContactRow | undefined>;
    // The sandbox-scoped contact an address already is, in whatever state.
    readonly byAddress: (address: string) => Promise<ContactRow | undefined>;
    readonly add: (input: S2sContactAdd) => Promise<ContactRow | ContactRefusal>;
    readonly accept: (id: string, grants: S2sGrants) => Promise<ContactRow | ContactRefusal>;
    // Whether this conversation is an automation's turn the owner lets accept a request by itself.
    readonly agentMayAccept: (conversationId: string) => Promise<boolean>;
}

const subjectOf = (subject: NeedSubject): ContactNeed | undefined => (subject.kind === "contact" ? subject : undefined);

const MESSAGES_ONLY: S2sGrants = S2sGrantsSchema.parse({});

const addedMet = (address: string): Met => ({
    result: `Asked ${address} to be a contact of this sandbox.`,
    use: ["It is a contact once that sandbox accepts: `messages contacts` shows its state, and a message sent before then waits for it."],
});

const acceptedMet = (address: string): Met => ({
    result: `${address} is a contact of this sandbox now.`,
    use: ["`messages send` reaches it, and what it sends arrives as messages."],
});

const resolveAdd = async (deps: ContactNeedDeps, ask: Extract<NeedAsk, { kind: "contact" }>): Promise<Resolved> => {
    const address = normalizeAddress(ask.address ?? "");
    if (address === undefined) {
        return { kind: "refused", code: "invalid_address", message: "Nothing was asked: name the sandbox by its host or its own domain (ops.acme.example)." };
    }
    const held = await deps.byAddress(address);
    if (held !== undefined && held.state !== "pending-in") {
        return held.state === "blocked"
            ? { kind: "refused", code: "blocked", message: `Nothing was asked: ${address} is blocked here.` }
            : { kind: "met", message: `${address} is already a contact here (${held.state}).` };
    }
    const subject: ContactNeed = { kind: "contact", address, action: "add", grants: ask.grants, ...opt("note", ask.note) };
    return { kind: "raise", subject, title: `Add ${address} as a contact` };
};

const resolveAccept = async (deps: ContactNeedDeps, ask: Extract<NeedAsk, { kind: "contact" }>, context: AskContext): Promise<Resolved> => {
    const row = ask.contactId === undefined ? undefined : await deps.contact(ask.contactId);
    if (row?.state !== "pending-in") {
        return { kind: "refused", code: "invalid", message: "Nothing was asked: an accept names a contact request waiting here (`messages contacts`)." };
    }
    if (sameGrants(ask.grants, MESSAGES_ONLY) && (await deps.agentMayAccept(context.conversationId))) {
        const accepted = await deps.accept(row.id, ask.grants);
        return isContactRefusal(accepted) ? { kind: "refused", code: "refused", message: accepted.refused } : { kind: "met", message: acceptedMet(row.address).result };
    }
    const subject: ContactNeed = { kind: "contact", address: row.address, action: "accept", contactId: row.id, grants: ask.grants, ...opt("note", row.note) };
    return { kind: "raise", subject, title: `Accept ${row.address} as a contact` };
};

// The press: the handshake's request, or the accept, carried out now.
const carryOut = async (deps: ContactNeedDeps, contact: ContactNeed): Promise<Answered> => {
    const done =
        contact.action === "add"
            ? await deps.add({ address: contact.address, grants: contact.grants, ...opt("note", contact.note) })
            : await deps.accept(contact.contactId ?? "", contact.grants);
    if (isContactRefusal(done)) {
        return { refused: done.refused };
    }
    return { status: "met", ...(contact.action === "add" ? addedMet(contact.address) : acceptedMet(contact.address)) };
};

export const contactNeed = (deps: ContactNeedDeps): NeedKindHandler => ({
    resolve: async (ask, context) => {
        if (ask.kind !== "contact") {
            return { kind: "refused", code: "invalid", message: "Not a contact ask." };
        }
        return ask.action === "add" ? resolveAdd(deps, ask) : resolveAccept(deps, ask, context);
    },
    // Done elsewhere (on the Messages tab) counts: the request went, or the contact was accepted.
    check: async (need) => {
        const contact = subjectOf(need.subject);
        const row = contact === undefined ? undefined : contact.contactId === undefined ? await deps.byAddress(contact.address) : await deps.contact(contact.contactId);
        if (contact === undefined || row === undefined) {
            return undefined;
        }
        if (contact.action === "add") {
            return row.state === "pending-out" || row.state === "accepted" ? addedMet(contact.address) : undefined;
        }
        return row.state === "accepted" ? acceptedMet(contact.address) : undefined;
    },
    // A sandbox-scoped contact is the owner's or a maintainer's to make (RAW_ROUTES `POST /s2s/contacts`).
    mayAnswer: (_need, by) => (by.maintainer === true ? undefined : "Only this sandbox's owner or a maintainer adds or accepts a contact for it."),
    answer: async (need, answer): Promise<Answered> => {
        const contact = subjectOf(need.subject);
        if (contact === undefined || answer.kind !== "approve") {
            return { refused: "A contact card is answered by adding or accepting the contact, or declined." };
        }
        return carryOut(deps, contact);
    },
    nextTurn: () => false,
    key: (subject) => {
        const contact = subjectOf(subject);
        return contact === undefined ? "" : `${contact.action}:${contact.address}:${contact.contactId ?? ""}`;
    },
});

/** The `contact` need kind, wired to this daemon. */
export const contactNeedOf = (whole: () => Services): NeedKindHandler =>
    contactNeed({
        contact: (id) => whole().s2s.contacts.get(id),
        byAddress: (address) => whole().s2s.contacts.find(address, { kind: "sandbox" }),
        add: (input) => addContact(whole().s2s.core, input),
        accept: (id, grants) => acceptContact(whole().s2s.core, id, grants),
        agentMayAccept: async (conversationId) =>
            (await whole().sandboxSettings.get()).contacts.agentMayAccept && whole().agents.entry(conversationId)?.identity.origin?.automationId !== undefined,
    });
