import { randomUUID } from "node:crypto";
import {
    BORROWED_ID_PREFIX,
    type BorrowedAccount,
    BorrowedAccountSchema,
} from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// THE ACCOUNTS THIS SANDBOX BORROWS from another of the owner's sandboxes (account-sharing.ts in the contract): where
// to ask for each, and nothing a provider would accept. The access tokens a turn is lent are held in memory only
// (borrowed-claude.ts), so neither this file nor a bundle of it ever carries a credential; the link token stays on its
// card.

const BorrowedAccountsFileSchema = z.object({ accounts: z.array(BorrowedAccountSchema) });

export const borrowedAccountsDocument = defineDocument({
    root: "history",
    path: "identity/borrowed-accounts.json",
    // Each names an accounts link this sandbox holds, and that link names this sandbox on the other side: on another
    // sandbox it would borrow in this one's name.
    portability: "identity",
    note: "Bring the accounts in again from the sandbox that lends them: Sandbox ▸ Models ▸ Use accounts from another sandbox.",
    schema: BorrowedAccountsFileSchema,
});

export interface BorrowedStore {
    readonly list: () => Promise<readonly BorrowedAccount[]>;
    readonly get: (id: string) => Promise<BorrowedAccount | undefined>;
    // Files one borrowed account, or answers the one already filed for the same card and account, so bringing an account
    // in twice leaves one row and every conversation pinned to it carries on.
    readonly add: (entry: Omit<BorrowedAccount, "id" | "borrowedAt">) => Promise<BorrowedAccount>;
    readonly remove: (id: string) => Promise<BorrowedAccount | undefined>;
}

const sameBorrow = (entry: Pick<BorrowedAccount, "card" | "provider" | "remote">, other: Pick<BorrowedAccount, "card" | "provider" | "remote">): boolean =>
    entry.card === other.card && entry.provider === other.provider && entry.remote === other.remote;

export const fileBorrowedStore = (path: string): BorrowedStore => {
    const file = openDocument(borrowedAccountsDocument, path, { fallback: () => ({ accounts: [] }), unknownKeys: true });
    return {
        list: async () => (await file.read()).accounts,
        get: async (id) => (await file.read()).accounts.find((entry) => entry.id === id),
        add: async (entry) => {
            let filed: BorrowedAccount | undefined;
            await file.update((stored) => {
                const earlier = stored.accounts.find((candidate) => sameBorrow(candidate, entry));
                if (earlier !== undefined) {
                    filed = { ...earlier, ...entry };
                    return { accounts: stored.accounts.map((candidate) => (candidate.id === earlier.id ? (filed ?? candidate) : candidate)) };
                }
                filed = { ...entry, id: `${BORROWED_ID_PREFIX}${randomUUID()}`, borrowedAt: Date.now() };
                return { accounts: [...stored.accounts, filed] };
            });
            if (filed === undefined) {
                throw new Error("the borrowed account was not filed");
            }
            return filed;
        },
        remove: async (id) => {
            let removed: BorrowedAccount | undefined;
            await file.update((stored) => {
                removed = stored.accounts.find((entry) => entry.id === id);
                return removed === undefined ? stored : { accounts: stored.accounts.filter((entry) => entry.id !== id) };
            });
            return removed;
        },
    };
};
