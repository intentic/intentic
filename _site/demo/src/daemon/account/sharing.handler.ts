import { providerSpec, TRANSLATOR_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import {
    BORROWED_ID_PREFIX,
    type BorrowedAccount,
    type BorrowOutcome,
    isBorrowedId,
    sameSharedRef,
    type ShareableAccount,
    type ShareableAccounts,
    type SharedAccountRef,
} from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import { DEMO_SANDBOX } from "../../platform";
import { DEMO_DAEMON_ORIGIN } from "../../transport";
import { LENDING_SANDBOX, rowAt } from "../../world/sandboxRegistry";
import { type Doors, okAfter } from "../doors";
import { lendingAccounts } from "./accounts";
import { capabilityList } from "./capabilities";
import { disconnectNativeAccount, fileNativeAccount, nativeAccounts, routedAccounts } from "./signIns";

// MODEL ACCOUNTS SHARED BETWEEN THE OWNER'S SANDBOXES (account-sharing.ts in the contract), as one fixture daemon answers
// for all of them: a call is told apart by the address it was sent to (ProcedureCall.url). The shop (this sandbox) lists
// what it holds itself; any other sandbox of the account lists the laptop's accounts (accounts.ts) under its own name.
// Bringing one in files it in this sandbox's own stores: a copied key as an account of its own, a lent Claude sign-in
// as a row borrowed from the sandbox the link card names, until Stop borrowing takes it off again.

const REAUTH = `It needs signing in again here first.`;
const TRANSLATOR_NOT_YET = `Subscriptions the translator holds can't be lent between sandboxes yet: sign in on this sandbox too.`;

// What this sandbox holds and how each would travel, the rule held-accounts.ts applies on the real daemon.
const shareableHere = (): ShareableAccounts => ({
    sandbox: DEMO_SANDBOX.name,
    accounts: [
        ...nativeAccounts(`claude`).map((row): ShareableAccount => {
            const base: Omit<ShareableAccount, `mode`> = { provider: `claude`, account: row.id, label: row.label };
            if (row.email !== undefined) {
                base.email = row.email;
            }
            if (row.borrowedFrom !== undefined || isBorrowedId(row.id)) {
                return { ...base, mode: `no`, reason: `It is borrowed from ${row.borrowedFrom?.name ?? `another sandbox`}: bring it in from there.` };
            }
            return row.needsReauth === true ? { ...base, mode: `no`, reason: REAUTH } : { ...base, mode: `lend` };
        }),
        ...TRANSLATOR_PROVIDERS.flatMap((provider): ShareableAccount[] => {
            const held = routedAccounts()[provider];
            return held.length === 0 ? [] : [{ provider, label: providerSpec(provider)?.accountLabel ?? provider, email: held.map((row) => row.label).join(`, `), mode: `no`, reason: TRANSLATOR_NOT_YET }];
        }),
    ],
});

/** What the sandbox at a call's address can share, under the name it calls itself. */
const shareableAt = (url: URL): ShareableAccounts =>
    url.origin === DEMO_DAEMON_ORIGIN
        ? shareableHere()
        : { sandbox: rowAt(url.origin)?.name ?? LENDING_SANDBOX.name, accounts: lendingAccounts().map((fixture) => fixture.shareable) };

let borrowed: BorrowedAccount[] = [];
let filed = 0;

// The source a card names: the name and id the editor saved on it when it minted the link over there.
const sourceOf = (card: string): BorrowedAccount[`from`] | undefined => {
    const saved = capabilityList().capabilities.find((candidate) => candidate.id === card && candidate.kind === `link`);
    if (saved === undefined) {
        return undefined;
    }
    const { name, sandboxId } = saved.config;
    const from: BorrowedAccount[`from`] = { name: String(name ?? card) };
    if (sandboxId !== undefined) {
        from.sandboxId = String(sandboxId);
    }
    return from;
};

const failed = (ref: SharedAccountRef, message: string): BorrowOutcome => ({ ...ref, outcome: `failed`, message });

// One account in: a lent Claude sign-in filed as borrowed (once per source account), a static key copied as this
// sandbox's own, and anything else refused in words the row shows.
const bringOne = (card: string, from: BorrowedAccount[`from`], ref: SharedAccountRef): BorrowOutcome => {
    const fixture = lendingAccounts().find((candidate) => sameSharedRef(candidate.shareable, ref));
    if (fixture === undefined) {
        return failed(ref, `${from.name} no longer holds that account.`);
    }
    const { shareable, row } = fixture;
    if (shareable.mode === `no`) {
        return failed(ref, shareable.reason ?? `${from.name} cannot share that account.`);
    }
    if (shareable.mode === `lend`) {
        const already = borrowed.find((entry) => entry.card === card && entry.remote === ref.account);
        if (already !== undefined) {
            return { ...ref, outcome: `borrowed`, id: already.id };
        }
        filed += 1;
        const id = `${BORROWED_ID_PREFIX}demo-${filed}`;
        const entry: BorrowedAccount = { id, card, provider: ref.provider, label: row.label, from, borrowedAt: Date.now() };
        if (ref.account !== undefined) {
            entry.remote = ref.account;
        }
        if (row.email !== undefined) {
            entry.email = row.email;
        }
        borrowed = [...borrowed, entry];
        fileNativeAccount(ref.provider, { ...row, id, connectedAt: entry.borrowedAt, borrowedFrom: from });
        return { ...ref, outcome: `borrowed`, id };
    }
    const copied = nativeAccounts(ref.provider).find((held) => held.label === row.label && held.email === row.email);
    if (copied !== undefined) {
        return { ...ref, outcome: `copied`, id: copied.id };
    }
    filed += 1;
    const id = `acc_${ref.provider}_copied_${filed}`;
    fileNativeAccount(ref.provider, { ...row, id, connectedAt: Date.now() });
    return { ...ref, outcome: `copied`, id };
};

export const sharingDoors = {
    shareable: (_input, call) => shareableAt(call.url),
    borrow: ({ card, items }) => {
        const from = sourceOf(card);
        return {
            results: items.map((ref) => (from === undefined ? failed(ref, `No link called ${card} is connected here.`) : bringOne(card, from, ref))),
        };
    },
    borrowed: () => ({ accounts: [...borrowed] }),
    stop: ({ id }) =>
        okAfter(() => {
            const entry = borrowed.find((candidate) => candidate.id === id);
            borrowed = borrowed.filter((candidate) => candidate.id !== id);
            disconnectNativeAccount(entry?.provider ?? `claude`, id);
        }),
} satisfies Doors<`sharing`>;
