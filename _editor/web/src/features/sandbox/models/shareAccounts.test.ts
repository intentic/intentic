import type { AddCapabilityInput } from "@intentic/capability-catalog";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { InboundLinkMint, InboundLinkSummary, InboundLinkTermsUpdate, LinkTerms } from "@intentic/sandbox-contract/schemas/links";
import type { AccountsBorrow, BorrowOutcome, SharedAccountRef } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import {
    accountsCardFor,
    accountsCardId,
    accountsLinkFrom,
    type BringAsk,
    bringAccounts,
    broughtIn,
    dropAtSource,
    lentOn,
    mergeOutcomes,
    openAccountsLink,
    refKey,
    type ShareCalls,
    stopLendingOn,
    unionRefs,
    withoutRef,
} from "./shareAccounts";

// Bringing accounts in from another of the owner's sandboxes: which link the press widens or mints over there, which card
// it saves here, and what it asks this sandbox to bring, in the order those calls are made.

const CLAUDE: SharedAccountRef = { provider: `claude`, account: `acc_max` };
const CURSOR: SharedAccountRef = { provider: `cursor`, account: `cur_1` };
const ENDPOINT: SharedAccountRef = { provider: `endpoint/openrouter` };

const SOURCE = { id: `sbx-laptop`, name: `Ada's Laptop`, daemonUrl: `https://laptop.example` };
const HERE = { id: `sbx-shop`, name: `acme-shop`, url: `https://shop.example` };

const card = (id: string, config: CapabilitySummary[`config`]): CapabilitySummary => ({
    id,
    kind: `link`,
    status: { state: `active` },
    config,
    secrets: [`token`],
});
const accountsCard = card(`accounts-ada-s-laptop`, { url: SOURCE.daemonUrl, name: SOURCE.name, sandboxId: SOURCE.id, purpose: `accounts` });

const terms = (change: Partial<LinkTerms> = {}): LinkTerms => ({ approve: false, turnsPerHour: 20, tasks: false, accounts: [], ...change });
const link = (id: string, change: Partial<InboundLinkSummary> = {}): InboundLinkSummary => ({
    id,
    label: HERE.name,
    from: { sandboxId: HERE.id, url: HERE.url },
    terms: terms(),
    createdAt: 0,
    conversations: 0,
    requests: [],
    ...change,
});

// Every call the press can make, each recorded in the order it was made, answering what the test hands it.
const recorded = (links: readonly InboundLinkSummary[] = [], outcomes: BorrowOutcome[] = []) => {
    const calls: string[] = [];
    const minted: InboundLinkMint[] = [];
    const saved: AddCapabilityInput[] = [];
    const retermed: { linkId: string; terms: InboundLinkTermsUpdate }[] = [];
    const borrowed: AccountsBorrow[] = [];
    const share: ShareCalls = {
        linksAt: async (sandboxId) => {
            calls.push(`links@${sandboxId}`);
            return links;
        },
        retermAt: async (sandboxId, linkId, sent) => {
            calls.push(`reterm@${sandboxId}`);
            retermed.push({ linkId, terms: sent });
        },
        mintAt: async (sandboxId, mint) => {
            calls.push(`mint@${sandboxId}`);
            minted.push(mint);
            return { id: `lnk_new`, token: `ilk_secret` };
        },
        revokeAt: async (sandboxId, linkId) => {
            calls.push(`revoke@${sandboxId}:${linkId}`);
        },
        saveCard: async (input) => {
            calls.push(`save`);
            saved.push(input);
        },
        borrow: async (ask) => {
            calls.push(`borrow`);
            borrowed.push(ask);
            return { results: outcomes };
        },
    };
    return { share, calls, minted, saved, retermed, borrowed };
};

const ask = (change: Partial<BringAsk> = {}): BringAsk => ({ source: SOURCE, here: HERE, refs: [CLAUDE], cards: [], ...change });

describe(`accountsCardId`, () => {
    it(`names the card for the source, apart from the task link pairing names for it`, () => {
        expect(accountsCardId(SOURCE.name, [])).toBe(`accounts-ada-s-laptop`);
    });

    it(`numbers past a card a namesake already holds`, () => {
        const held = [card(`accounts-ada-s-laptop`, {}), card(`accounts-ada-s-laptop-2`, {})];
        expect(accountsCardId(SOURCE.name, held)).toBe(`accounts-ada-s-laptop-3`);
    });

    // A capability id is at most 60 characters (schemas/internal.ts entryId), and may not end in a separator.
    it(`stays within a capability id's length`, () => {
        const id = accountsCardId(`a`.repeat(80), [card(`accounts-${`a`.repeat(51)}`, {})]);
        expect(id.length).toBeLessThanOrEqual(60);
        expect(id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]*[a-zA-Z0-9]$/);
        expect(id.endsWith(`-2`)).toBe(true);
    });
});

describe(`the refs a link names`, () => {
    it(`adds only what the link does not name yet, and drops label and mode`, () => {
        const shareable = { ...CURSOR, label: `Cursor`, mode: `copy` as const };
        expect(unionRefs([CLAUDE], [CLAUDE, shareable, ENDPOINT])).toEqual([CLAUDE, CURSOR, ENDPOINT]);
    });

    it(`takes one off, telling a provider shared whole from one of its accounts`, () => {
        expect(withoutRef([CLAUDE, CURSOR, ENDPOINT], { provider: `endpoint/openrouter` })).toEqual([CLAUDE, CURSOR]);
        expect(withoutRef([CLAUDE], { provider: `claude` })).toEqual([CLAUDE]);
    });
});

describe(`which card and link are the source's`, () => {
    it(`finds the accounts card for the source only, not a task link to it`, () => {
        const taskCard = card(`ada-s-laptop`, { url: SOURCE.daemonUrl, sandboxId: SOURCE.id });
        const otherSource = card(`accounts-studio`, { sandboxId: `sbx-studio`, purpose: `accounts` });
        expect(accountsCardFor([taskCard, otherSource, accountsCard], SOURCE.id)).toBe(accountsCard);
        expect(accountsCardFor([taskCard, otherSource], SOURCE.id)).toBeUndefined();
    });

    it(`finds the link minted for this sandbox that takes no tasks`, () => {
        const taskLink = link(`lnk_tasks`, { terms: terms({ tasks: true }) });
        const someoneElse = link(`lnk_other`, { from: { sandboxId: `sbx-studio` } });
        const ours = link(`lnk_ours`);
        expect(accountsLinkFrom([taskLink, someoneElse, ours], HERE.id)).toBe(ours);
        expect(accountsLinkFrom([taskLink, someoneElse], HERE.id)).toBeUndefined();
        expect(accountsLinkFrom([ours], undefined)).toBeUndefined();
    });
});

describe(`openAccountsLink`, () => {
    it(`mints a link on the source that lends exactly the chosen accounts, then saves its card here`, async () => {
        const wire = recorded();
        const id = await openAccountsLink(ask({ refs: [{ ...CLAUDE }, CURSOR] }), wire.share);
        expect(id).toBe(`accounts-ada-s-laptop`);
        expect(wire.calls).toEqual([`mint@sbx-laptop`, `save`]);
        expect(wire.minted).toEqual([
            {
                label: `acme-shop`,
                from: { sandboxId: HERE.id, url: HERE.url },
                terms: { tasks: false, approve: false, accounts: [CLAUDE, CURSOR] },
            },
        ]);
        expect(wire.saved).toEqual([
            {
                id: `accounts-ada-s-laptop`,
                kind: `link`,
                config: { url: SOURCE.daemonUrl, token: `ilk_secret`, name: SOURCE.name, sandboxId: SOURCE.id, purpose: `accounts` },
            },
        ]);
    });

    it(`widens the link the source already holds for this sandbox, and mints nothing`, async () => {
        const wire = recorded([link(`lnk_ours`, { terms: terms({ accounts: [CURSOR] }) })]);
        const id = await openAccountsLink(ask({ cards: [accountsCard] }), wire.share);
        expect(id).toBe(accountsCard.id);
        expect(wire.calls).toEqual([`links@sbx-laptop`, `reterm@sbx-laptop`]);
        // Every defaulted term goes as the link has it: the route fills one left out with its default, and `tasks`'s is true.
        expect(wire.retermed).toEqual([{ linkId: `lnk_ours`, terms: { approve: false, turnsPerHour: 20, tasks: false, accounts: [CURSOR, CLAUDE] } }]);
    });

    it(`leaves a link that already lends them as it is`, async () => {
        const wire = recorded([link(`lnk_ours`, { terms: terms({ accounts: [CLAUDE] }) })]);
        await openAccountsLink(ask({ cards: [accountsCard] }), wire.share);
        expect(wire.calls).toEqual([`links@sbx-laptop`]);
    });

    // The card stands here but its link was revoked over there: a new link, its token saved over the same card.
    it(`mints again over a card whose link is gone, keeping the card's id`, async () => {
        const wire = recorded([link(`lnk_tasks`, { terms: terms({ tasks: true }) })]);
        const renamed = { ...accountsCard, id: `accounts-laptop` };
        const id = await openAccountsLink(ask({ cards: [renamed] }), wire.share);
        expect(id).toBe(`accounts-laptop`);
        expect(wire.calls).toEqual([`links@sbx-laptop`, `mint@sbx-laptop`, `save`]);
        expect(wire.saved[0]?.id).toBe(`accounts-laptop`);
    });

    it(`revokes the link it just minted when the card cannot be saved, and says why it failed`, async () => {
        const wire = recorded();
        const refused = { ...wire.share, saveCard: () => Promise.reject(new Error(`refused`)) };
        await expect(openAccountsLink(ask(), refused)).rejects.toThrow(`refused`);
        expect(wire.calls).toEqual([`mint@sbx-laptop`, `revoke@sbx-laptop:lnk_new`]);
    });

    it(`names this sandbox by its id when it has no name to give`, async () => {
        const wire = recorded();
        await openAccountsLink(ask({ here: { id: HERE.id, name: `  `, url: undefined } }), wire.share);
        expect(wire.minted[0]?.label).toBe(HERE.id);
        expect(wire.minted[0]?.from).toEqual({ sandboxId: HERE.id });
    });
});

describe(`bringAccounts`, () => {
    it(`asks this sandbox to bring the chosen accounts in over the card, and answers each one's outcome`, async () => {
        const outcomes: BorrowOutcome[] = [
            { ...CLAUDE, outcome: `borrowed`, id: `lent-1` },
            { ...CURSOR, outcome: `failed`, message: `That key has expired.` },
        ];
        const wire = recorded([], outcomes);
        const shareable = [
            { ...CLAUDE, label: `Claude Max`, mode: `lend` as const },
            { ...CURSOR, label: `Cursor`, mode: `copy` as const },
        ];
        expect(await bringAccounts(ask({ refs: shareable }), wire.share)).toEqual(outcomes);
        expect(wire.calls).toEqual([`mint@sbx-laptop`, `save`, `borrow`]);
        expect(wire.borrowed).toEqual([{ card: `accounts-ada-s-laptop`, items: [CLAUDE, CURSOR] }]);
    });
});

describe(`what a press did, this visit`, () => {
    it(`keeps the latest outcome per account, and counts only a success as brought`, () => {
        const first = mergeOutcomes(new Map(), [{ ...CURSOR, outcome: `failed`, message: `no` }]);
        const second = mergeOutcomes(first, [{ ...CURSOR, outcome: `copied`, id: `cur_9` }, { ...CLAUDE, outcome: `borrowed` }]);
        expect(broughtIn(first.get(refKey(CURSOR)))).toBe(false);
        expect(broughtIn(second.get(refKey(CURSOR)))).toBe(true);
        expect(broughtIn(second.get(refKey(CLAUDE)))).toBe(true);
        expect(broughtIn(second.get(refKey(ENDPOINT)))).toBe(false);
    });
});

describe(`stopping a loan`, () => {
    it(`takes a borrowed account off the source's link for this sandbox`, async () => {
        const wire = recorded([link(`lnk_ours`, { terms: terms({ accounts: [CLAUDE, CURSOR] }) })]);
        await dropAtSource({ sourceId: SOURCE.id, hereId: HERE.id, ref: CLAUDE }, wire.share);
        expect(wire.retermed).toEqual([{ linkId: `lnk_ours`, terms: { approve: false, turnsPerHour: 20, tasks: false, accounts: [CURSOR] } }]);
    });

    it(`changes nothing over there when the link is gone or no longer names it`, async () => {
        const gone = recorded([]);
        await dropAtSource({ sourceId: SOURCE.id, hereId: HERE.id, ref: CLAUDE }, gone.share);
        const unnamed = recorded([link(`lnk_ours`, { terms: terms({ accounts: [CURSOR] }) })]);
        await dropAtSource({ sourceId: SOURCE.id, hereId: HERE.id, ref: CLAUDE }, unnamed.share);
        expect([...gone.calls, ...unnamed.calls]).toEqual([`links@sbx-laptop`, `links@sbx-laptop`]);
    });

    it(`finds the accounts links lending one of this sandbox's own, never a task link`, () => {
        const lending = link(`lnk_laptop`, { label: `laptop`, terms: terms({ accounts: [CLAUDE] }) });
        const tasks = link(`lnk_tasks`, { terms: terms({ tasks: true, accounts: [CLAUDE] }) });
        expect(lentOn([lending, tasks, link(`lnk_empty`)], CLAUDE)).toEqual([lending]);
    });

    it(`re-terms a link that still lends something else, and revokes one left lending nothing`, () => {
        const lending = link(`a`, { terms: terms({ approve: true, turnsPerHour: 7, accounts: [CLAUDE, CURSOR] }) });
        expect(stopLendingOn(lending, CLAUDE)).toEqual({ terms: { approve: true, turnsPerHour: 7, tasks: false, accounts: [CURSOR] } });
        expect(stopLendingOn(link(`b`, { terms: terms({ accounts: [CLAUDE] }) }), CLAUDE)).toEqual({ revoke: true });
    });
});
