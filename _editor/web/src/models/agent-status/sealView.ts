import type { SealHouse, SealOpen, SealPerson, SealView } from "@intentic/sandbox-contract/schemas/seal";
import { t } from "@intentic/ui/i18n";

// HOW ONE PRIVATE CONVERSATION READS TO THE PERSON LOOKING (sandbox-contract schemas/seal.ts): a sealed card they cannot
// read, a reader's whole view, or someone let in for a while, read-only. Pure, so the card, the gate, the chat's head and
// the composer answer from one reading rather than each re-deriving the seal's rules.

/** Anything that carries a summary's seal: a summary, a fleet card, or nothing. */
type Sealable = { readonly seal?: SealView | undefined } | undefined;

/** The caller cannot read it: the daemon cut the summary to a sealed card (whose it is, where it stands, its diff). */
export const isSealed = (agent: Sealable): boolean => agent?.seal?.sealed === true;

/** What a conversation is called where its title is withheld: never its title, anywhere. */
export const sealedTitle = (): string => t(`chat.seal.privateConversation`);

/** Whose it is: the seal names its author first among its readers, on a sealed card as on a reader's view. */
export const sealAuthor = (seal: SealView | undefined): SealPerson | undefined => seal?.readers?.[0];

/** A person as a sentence names them: their first name, else their address up to the @. */
export const firstName = (person: SealPerson | undefined): string => {
    const named = person?.name?.trim().split(/\s+/u)[0];
    if (named !== undefined && named !== ``) {
        return named;
    }
    return person?.email.split(`@`)[0] ?? ``;
};

/** A person as a card or a row names them: their whole name, else their address. */
export const fullName = (person: SealPerson | undefined): string => person?.name?.trim() || (person?.email ?? ``);

const same = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** The caller reads it as one of its readers (its author or someone they added): they may change who reads it. */
export const readsAsReader = (agent: Sealable): boolean => agent?.seal?.via === `reader`;

/** Until when the caller may read it, when they read it read-only (shown for a day, or opened without asking). */
export const readOnlyUntil = (agent: Sealable): number | undefined => {
    const via = agent?.seal?.via;
    return via === `grant` || via === `open` ? agent?.seal?.until : undefined;
};

/** The readers besides the author, the ones a reader's chips show and may take away. */
export const addedReaders = (seal: SealView | undefined): readonly SealPerson[] => seal?.readers?.slice(1) ?? [];

/**
 * The pill's words: "Shared", or "Private" with who reads it, said from where the reader stands ("you and Ola",
 * "Anna and you", "only you", "you and 3 others").
 */
export const sealLabel = (seal: SealView | undefined, me: string | undefined): string => {
    if (seal === undefined) {
        return t(`chat.seal.shared`);
    }
    const others = (seal.readers ?? []).filter((reader) => !same(reader.email, me));
    if (others.length === 0) {
        return t(`chat.seal.privateOnlyYou`);
    }
    if (others.length === 1) {
        return t(`chat.seal.privateWith`, { name: firstName(others[0]) });
    }
    return t(`chat.seal.privateWithMany`, { count: others.length }, others.length);
};

/** Whether the pill is offered at all: never in a house where nothing new can be private, unless this one already is. */
export const pillOffered = (house: Pick<SealHouse, `mode`> | undefined, seal: SealView | undefined): boolean =>
    seal !== undefined || (house !== undefined && house.mode !== `everyone`);

/** An opening without asking, by where it stands: read now, waiting on a second person, or refused by one. */
export type OpeningStanding = `opened` | `pending` | `refused`;
export const openingStanding = (open: SealOpen): OpeningStanding => {
    if (open.refusedBy !== undefined) {
        return `refused`;
    }
    return open.pending === true ? `pending` : `opened`;
};

/** Every opening a reader's view keeps, newest first: the record stays for good, so nothing here is ever dropped. */
export const openingsOf = (seal: SealView | undefined): readonly SealOpen[] => (seal?.opens ?? []).toSorted((a, b) => b.at - a.at);

/** Whether the caller asked for this pending opening (they see it waiting), rather than being asked to agree to it. */
export const isOpener = (open: SealOpen | undefined, me: string | undefined): boolean => same(open?.email, me);
