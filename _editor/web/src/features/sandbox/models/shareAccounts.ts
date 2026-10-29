import type { AddCapabilityInput } from "@intentic/capability-catalog";
import type { CapabilitySummary, LinkConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { InboundLinkMint, InboundLinkMinted, InboundLinkSummary, InboundLinkTermsUpdate } from "@intentic/sandbox-contract/schemas/links";
import {
    type AccountsBorrow,
    type AccountsBorrowed,
    type BorrowOutcome,
    sameSharedRef,
    type ShareableAccount,
    type SharedAccountRef,
} from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import { linkCardId } from "../../../components/linkPairing";

// BRINGING MODEL ACCOUNTS IN FROM ANOTHER OF THE OWNER'S SANDBOXES (account-sharing.ts in the contract), done by this
// editor because it is the one party signed in to both, as pairing a task link is (components/linkPairing.ts). One press:
// widen the accounts link the source already holds for this sandbox, or mint one there and save its card here, then ask
// this sandbox to bring the accounts in over it. Which way each account goes (copied, lent, not at all) is the source's
// call; this only carries the owner's choice. Every call is handed in, so the order of them is what the tests read.

/** The sandbox the accounts come from, as the account lists it. */
export interface ShareSource {
    readonly id: string;
    readonly name: string;
    readonly daemonUrl: string;
}

/** This sandbox, as the link over there names it. */
export interface ShareHere {
    readonly id: string | undefined;
    readonly name: string;
    readonly url: string | undefined;
}

/** The far calls (on the source, by its id) and the near ones (on this sandbox) the press makes. */
export interface ShareCalls {
    readonly linksAt: (sandboxId: string) => Promise<readonly InboundLinkSummary[]>;
    readonly retermAt: (sandboxId: string, linkId: string, terms: InboundLinkTermsUpdate) => Promise<void>;
    readonly mintAt: (sandboxId: string, mint: InboundLinkMint) => Promise<InboundLinkMinted>;
    readonly revokeAt: (sandboxId: string, linkId: string) => Promise<void>;
    readonly saveCard: (card: AddCapabilityInput) => Promise<void>;
    readonly borrow: (ask: AccountsBorrow) => Promise<AccountsBorrowed>;
}

/** One account's key among others, for a per-visit map of what a press did to it. */
export const refKey = (ref: SharedAccountRef): string => `${ref.provider}\u0000${ref.account ?? ``}`;

/** Just the ref: a shareable row carries its label and mode beside it, which no link's terms take. */
export const refOf = (ref: SharedAccountRef): SharedAccountRef => (ref.account === undefined ? { provider: ref.provider } : { provider: ref.provider, account: ref.account });

/** What the link names already, then what it does not yet, each once. */
export const unionRefs = (current: readonly SharedAccountRef[], more: readonly SharedAccountRef[]): SharedAccountRef[] => {
    const all = current.map(refOf);
    for (const ref of more) {
        if (!all.some((held) => sameSharedRef(held, ref))) {
            all.push(refOf(ref));
        }
    }
    return all;
};

export const withoutRef = (current: readonly SharedAccountRef[], ref: SharedAccountRef): SharedAccountRef[] =>
    current.filter((held) => !sameSharedRef(held, ref)).map(refOf);

/** The rows a press may bring: everything the source can share at all, one way or the other. */
export const bringable = (accounts: readonly ShareableAccount[]): ShareableAccount[] => accounts.filter((account) => account.mode !== `no`);

/** The accounts link card this sandbox saved for the source, if any. */
export const accountsCardFor = (cards: readonly CapabilitySummary[], sourceId: string): CapabilitySummary | undefined =>
    cards.find((card) => card.kind === `link` && card.config[`purpose`] === `accounts` && card.config[`sandboxId`] === sourceId);

/**
 * A link's terms with only its accounts changed. Every defaulted term is sent as the link has it: the route keeps a term
 * left out since 2026-10-29 (links.ts InboundLinkTermsUpdateSchema), but a source on an older build would fill it with
 * its default (`tasks` true among them) and turn an accounts link into one taking tasks.
 */
const accountsTerms = (link: InboundLinkSummary, accounts: readonly SharedAccountRef[]): InboundLinkTermsUpdate => ({
    approve: link.terms.approve,
    turnsPerHour: link.terms.turnsPerHour,
    tasks: link.terms.tasks,
    accounts: accounts.map(refOf),
});

/** A link that only lends accounts (it takes no tasks). An older daemon's links read as task links, its terms defaulted. */
const isAccountsLink = (link: Pick<InboundLinkSummary, `terms`>): boolean => link.terms.tasks === false;

/** The accounts link the source holds for this sandbox: minted for it, and taking no tasks. */
export const accountsLinkFrom = (links: readonly InboundLinkSummary[], hereId: string | undefined): InboundLinkSummary | undefined =>
    hereId === undefined ? undefined : links.find((link) => isAccountsLink(link) && link.from?.sandboxId === hereId);

// A capability id's own alphabet and length (schemas/internal.ts entryId): `accounts-` and the most of the name that fits.
const CARD_ID_MAX = 60;
const CARD_PREFIX = `accounts-`;

/** A card id for the source that no other card here holds: `accounts-<its name>`, numbered past a namesake's. */
export const accountsCardId = (name: string, cards: readonly CapabilitySummary[]): string => {
    const base = `${CARD_PREFIX}${linkCardId(name)}`.slice(0, CARD_ID_MAX).replace(/[-_]+$/, ``);
    const taken = new Set(cards.map((card) => card.id));
    if (!taken.has(base)) {
        return base;
    }
    for (let n = 2; ; n += 1) {
        const suffix = `-${n}`;
        const candidate = `${base.slice(0, CARD_ID_MAX - suffix.length)}${suffix}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
};

// The label a link is minted under is the asking sandbox's name, within the route's own limit (InboundLinkMintSchema).
const LABEL_MAX = 60;

export interface BringAsk {
    readonly source: ShareSource;
    readonly here: ShareHere;
    readonly refs: readonly SharedAccountRef[];
    // This sandbox's cards as last read, to find the one saved for the source.
    readonly cards: readonly CapabilitySummary[];
}

// A new link on the source, naming this sandbox and lending exactly `refs`, and the card that holds its token here. A
// card that cannot be saved leaves no link behind over there to lend to nobody.
const mintLink = async ({ source, here, refs }: BringAsk, calls: ShareCalls, cardId: string): Promise<string> => {
    const from: NonNullable<InboundLinkMint[`from`]> = {};
    if (here.id !== undefined) {
        from.sandboxId = here.id;
    }
    if (here.url !== undefined) {
        from.url = here.url;
    }
    const label = here.name.trim().slice(0, LABEL_MAX).trim() || here.id || cardId;
    const minted = await calls.mintAt(source.id, { label, from, terms: { tasks: false, approve: false, accounts: refs.map(refOf) } });
    const config = { url: source.daemonUrl, token: minted.token, name: source.name, sandboxId: source.id, purpose: `accounts` } satisfies LinkConfig;
    try {
        await calls.saveCard({ id: cardId, kind: `link`, config });
    } catch (failure) {
        // allow(silent-catch): the save's own failure is what the reader is told; a link left over there lends to nobody.
        await calls.revokeAt(source.id, minted.id).catch(() => undefined);
        throw failure;
    }
    return cardId;
};

/**
 * Makes sure the source lends `refs` to this sandbox, and answers the card here the accounts come in through: the
 * existing link widened when its card is here and the link still stands there, else a new link and its card.
 */
export const openAccountsLink = async (ask: BringAsk, calls: ShareCalls): Promise<string> => {
    const card = accountsCardFor(ask.cards, ask.source.id);
    if (card !== undefined) {
        const link = accountsLinkFrom(await calls.linksAt(ask.source.id), ask.here.id);
        if (link !== undefined) {
            const accounts = unionRefs(link.terms.accounts, ask.refs);
            if (accounts.length !== link.terms.accounts.length) {
                await calls.retermAt(ask.source.id, link.id, accountsTerms(link, accounts));
            }
            return card.id;
        }
        // Revoked over there: a new link, its token saved over the card that held the old one.
        return mintLink(ask, calls, card.id);
    }
    return mintLink(ask, calls, accountsCardId(ask.source.name, ask.cards));
};

/** The whole press: the link, then this sandbox bringing each account in, each answering on its own. */
export const bringAccounts = async (ask: BringAsk, calls: ShareCalls): Promise<readonly BorrowOutcome[]> => {
    const card = await openAccountsLink(ask, calls);
    return (await calls.borrow({ card, items: ask.refs.map(refOf) })).results;
};

/** What a press answered, merged over what earlier presses this visit did, by account. */
export const mergeOutcomes = (
    earlier: ReadonlyMap<string, BorrowOutcome>,
    results: readonly BorrowOutcome[],
): ReadonlyMap<string, BorrowOutcome> => new Map([...earlier, ...results.map((result) => [refKey(result), result] as const)]);

/** Whether a row was brought in this visit, so it offers no second press. */
export const broughtIn = (outcome: BorrowOutcome | undefined): boolean => outcome !== undefined && outcome.outcome !== `failed`;

/* STOPPING: the borrowing side forgets one, and the lending side takes it off the link. */

/**
 * The source stops lending `ref` to this sandbox: taken off the accounts link it holds for this one, if that still
 * stands. Best effort on the caller's side, since this sandbox has already stopped asking for it.
 */
export const dropAtSource = async (
    { sourceId, hereId, ref }: { readonly sourceId: string; readonly hereId: string | undefined; readonly ref: SharedAccountRef },
    calls: Pick<ShareCalls, `linksAt` | `retermAt`>,
): Promise<void> => {
    const link = accountsLinkFrom(await calls.linksAt(sourceId), hereId);
    if (link !== undefined && link.terms.accounts.some((held) => sameSharedRef(held, ref))) {
        await calls.retermAt(sourceId, link.id, accountsTerms(link, withoutRef(link.terms.accounts, ref)));
    }
};

/** The accounts links on this sandbox that lend `ref` to another of the owner's sandboxes. */
export const lentOn = (links: readonly InboundLinkSummary[], ref: SharedAccountRef): InboundLinkSummary[] =>
    links.filter((link) => isAccountsLink(link) && link.terms.accounts.some((held) => sameSharedRef(held, ref)));

/** What stopping the loan of `ref` does to one link: new terms without it, or, with nothing left to lend, the link gone. */
export const stopLendingOn = (link: InboundLinkSummary, ref: SharedAccountRef): { readonly revoke: true } | { readonly terms: InboundLinkTermsUpdate } => {
    const rest = withoutRef(link.terms.accounts, ref);
    return rest.length === 0 ? { revoke: true } : { terms: accountsTerms(link, rest) };
};
