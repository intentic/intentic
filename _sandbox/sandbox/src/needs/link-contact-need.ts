import type { CapabilityNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
import type { Services } from "../composition.js";
import { contactServerName } from "../s2s/contacts/contact-mounts.js";
import { sandboxContactNamed } from "../s2s/contacts/contacts-store.js";
import type { Met, NeedKindHandler } from "./need-kinds.js";

// A LINKED SANDBOX ASKED FOR, MET BY A CONTACT (2026-11-27, docs/architecture/messages.md "Across versions"): an agent's
// `capabilities request link --target <sandbox>` raises the capability card, whose pairing makes a contact rather than a
// link card once both sandboxes speak s2s/1 (the editor's components/linkPairing.ts). The card is then met by that
// contact: what the link would have given, under the name its tools go by. Wrapped around the capability kind rather
// than written into it, so the capability kind knows nothing of contacts.

// The contact's name for its tools, when the sandbox the ask names is an accepted sandbox-scoped contact here.
export type ContactFor = (target: string) => Promise<{ readonly name: string } | undefined>;

const linkTarget = (need: Need): string | undefined => {
    const subject: CapabilityNeed | undefined = need.subject.kind === "capability" ? need.subject : undefined;
    return subject?.entry === "link" && subject.mode === "connect" ? subject.target : undefined;
};

const metBy = (target: string, name: string): Met => ({
    result: `${target} is a contact of this sandbox now, "${name}", rather than a link card.`,
    use: [`From your next turn hand it tasks with \`mcp__${name}__delegate\`, or send it a message with \`messages send ${name}\`.`],
});

const contactMet = async (contactFor: ContactFor, need: Need): Promise<Met | undefined> => {
    const target = linkTarget(need);
    const contact = target === undefined ? undefined : await contactFor(target);
    return target === undefined || contact === undefined ? undefined : metBy(target, contact.name);
};

/** The capability kind, a link it asks for also met by a contact for the sandbox it names. */
export const metByContact = (contactFor: ContactFor, kind: NeedKindHandler): NeedKindHandler => ({
    ...kind,
    check: async (need) => (await kind.check(need)) ?? (await contactMet(contactFor, need)),
    answer: async (need, answer, by) => {
        const answered = await kind.answer(need, answer, by);
        const contact = "refused" in answered && answer.kind === "apply" ? await contactMet(contactFor, need) : undefined;
        return contact === undefined ? answered : { status: "met", ...contact };
    },
});

/** This daemon's contacts, as the wrapper reads them. */
export const contactForOf =
    (whole: () => Pick<Services, "s2s">): ContactFor =>
    async (target) => {
        const { s2s } = whole();
        const row = await sandboxContactNamed(s2s.contacts, target, s2s.core.deps.zone);
        return row === undefined ? undefined : { name: contactServerName(row) };
    };
