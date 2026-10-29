import { isBorrowedId } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { ClaudeStore } from "./claude-credentials.js";

// CLAUDE SIGN-INS ANOTHER OF THE OWNER'S SANDBOXES LENDS HERE, turn by turn (links/accounts/, account-sharing.ts in the
// contract). That sandbox keeps the refresh token and renews it; this one is handed an access token per turn and a new
// one when a provider refuses it mid-turn. Two sandboxes renewing one login would sign each other out, so a borrowed
// account is never written to this sandbox's own store: it is listed beside the stored ones, under an id of its own
// (`lent-…`), and every token for it is asked of the lender.
//
// Built by the links slice and handed to the Claude store here (withLender), so every reader of the store sees the
// borrowed rows and every token path (ensureFreshToken, replaceRejectedToken) reaches the lender without knowing it.

export interface ClaudeLender {
    readonly owns: (id: string) => boolean;
    // The borrowed rows, as the lending sandbox last described them: its usage reading, and its word on whether the
    // sign-in still works there.
    readonly rows: () => Promise<OauthAccount[]>;
    // An access token for a turn, or a thrown sentence saying why there is none (the lender is not answering, or it no
    // longer lends the account).
    readonly token: (id: string) => Promise<string | undefined>;
    // A fresh token in place of `rejected`, or undefined when the lender could not renew the sign-in.
    readonly replace: (id: string, rejected: string) => Promise<string | undefined>;
    readonly forget: (id: string) => Promise<void>;
}

/** The store with the borrowed accounts beside its own: listed, cleared and asked for tokens, never written. */
export const withLender = (store: ClaudeStore, lender: () => ClaudeLender | undefined): ClaudeStore => ({
    ...store,
    lender,
    read: async (id) => (isBorrowedId(id) ? undefined : await store.read(id)),
    write: async (account) => {
        if (isBorrowedId(account.id)) {
            throw new Error("A borrowed Claude account is held by the sandbox that lends it: rename or sign it in again there.");
        }
        await store.write(account);
    },
    clear: async (id) => {
        const lending = lender();
        if (lending?.owns(id) === true) {
            await lending.forget(id);
            return;
        }
        await store.clear(id);
    },
    list: async () => {
        const own = await store.list();
        const lending = lender();
        // allow(silent-catch): a lender that cannot say what it lends right now leaves this sandbox's own accounts listed.
        const borrowed = lending === undefined ? [] : await lending.rows().catch(() => []);
        return [...own, ...borrowed];
    },
});

/** The lender a token for `id` must come from, when `id` is a borrowed account. */
export const lenderFor = (store: ClaudeStore, id: string): ClaudeLender | undefined => {
    // Only a borrowed id is ever asked of the lender: every other account is the store's own, as before lending existed.
    if (!isBorrowedId(id)) {
        return undefined;
    }
    const lending = store.lender?.();
    return lending?.owns(id) === true ? lending : undefined;
};
