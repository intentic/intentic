import type { OauthAccount } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { accountFiles } from "../../../agent/providers/accounts/account-files.js";

// Devin accounts, one JSON file per account under the auth root. Holds the key Devin's own CLI sign-in hands back (what
// `devin auth login` writes to its credentials.toml), not the CLI's file itself: that file holds one account, and this
// sandbox holds several. The key does not expire, so there is nothing to refresh; a revoked one shows as a refused turn.

const StoredAccountSchema = z.object({
    id: z.string().min(1),
    // What the user typed, if renamed; absent means the row derives its name (see displayLabel).
    label: z.string().optional(),
    // Who Devin says this is (`devin auth status`); absent when it did not say, the case renaming exists for.
    email: z.string().optional(),
    // The plan Devin names for the account (Free, Pro, Max, Teams…), shown on the row so two accounts read apart.
    plan: z.string().optional(),
    apiKey: z.string().min(1),
    connectedAt: z.number(),
    // Set once a turn on this key was refused as signed out: the key is dead, and only a new sign-in revives the row.
    refusedAt: z.number().optional(),
});
export type StoredDevinAccount = z.infer<typeof StoredAccountSchema>;

// Row name: what the user typed, else who Devin says this is, else "Devin". Derived on every read, never stored.
export const displayLabel = (stored: Pick<StoredDevinAccount, "label" | "email">): string => stored.label?.trim() || stored.email || "Devin";

// Account-list view with the key removed, in the shape every provider's row takes.
export const toAccount = (stored: StoredDevinAccount): OauthAccount => ({
    id: stored.id,
    label: displayLabel(stored),
    connectedAt: stored.connectedAt,
    ...(stored.email !== undefined ? { email: stored.email } : {}),
    ...(stored.refusedAt !== undefined
        ? { needsReauth: true, detail: "Devin no longer accepts this sign-in. Connect it again to keep running turns on it." }
        : stored.plan !== undefined
          ? { detail: `Devin ${stored.plan} plan` }
          : {}),
});

export interface DevinStore {
    readonly read: (id: string) => Promise<StoredDevinAccount | undefined>;
    readonly write: (account: StoredDevinAccount) => Promise<void>;
    readonly clear: (id: string) => Promise<void>;
    readonly list: () => Promise<OauthAccount[]>;
    // Stored accounts with keys included; only the turn path and catalog call this, list() cannot leak one.
    readonly credentials: () => Promise<StoredDevinAccount[]>;
    readonly logger: Logger;
}

// Files with Devin's own account shape; shared with the provider-pack predicate so a stray file can't make a
// disconnected sandbox look connected.
export const readDevinCredentials = (dir: string): Promise<StoredDevinAccount[]> => accountFiles(dir, StoredAccountSchema).list();

// One <id>.json per account under .intentic/secrets/auth/devin/, already classified secret (workspace-state.ts): fenced
// from search, export and file routes without naming it.
export const fileDevinStore = (dir: string, logger: Logger): DevinStore => {
    const files = accountFiles(dir, StoredAccountSchema);
    return {
        logger,
        read: files.read,
        write: files.write,
        clear: files.remove,
        list: async () => (await files.list()).map(toAccount),
        credentials: files.list,
    };
};

// Accounts a turn could run on, oldest connection first (first-connected-is-default, where nothing else decides).
export const liveDevinAccounts = async (store: DevinStore): Promise<StoredDevinAccount[]> =>
    (await store.credentials()).filter((account) => account.refusedAt === undefined);
