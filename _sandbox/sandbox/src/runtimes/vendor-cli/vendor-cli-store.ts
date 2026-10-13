import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { OauthAccount } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { accountFiles } from "../../agent/providers/accounts/account-files.js";
import { opt } from "../../opt.js";
import type { VendorCli } from "./vendor-cli.js";

// A vendor CLI's accounts: one `<id>.json` of facts per account, and beside it the CLI's own home for that account
// (`homes/<id>/`), which holds the tokens the CLI's login wrote and refreshes itself, its config and its sessions. The
// daemon never reads a token out of a home: the CLI is the only thing that spends one. Both live under the auth root,
// already classified secret (workspace-state.ts), so search, export and the file routes never reach them.

const StoredAccountSchema = z.object({
    id: z.string().min(1),
    // What the user typed, if renamed; absent means the row derives its name (displayLabel).
    label: z.string().optional(),
    // Who the CLI's sign-in says this is, where it said; absent is the case renaming exists for.
    email: z.string().optional(),
    connectedAt: z.number(),
    // Set once a turn was refused as signed out: the CLI could not renew the sign-in, and only a new one revives the row.
    refusedAt: z.number().optional(),
});
export type StoredCliAccount = z.infer<typeof StoredAccountSchema>;

export interface CliStore {
    readonly read: (id: string) => Promise<StoredCliAccount | undefined>;
    readonly write: (account: StoredCliAccount) => Promise<void>;
    // The account's facts and its home, together: a forgotten account leaves no token behind.
    readonly clear: (id: string) => Promise<void>;
    readonly list: () => Promise<OauthAccount[]>;
    readonly accounts: () => Promise<StoredCliAccount[]>;
    // Where the CLI keeps this account's sign-in and sessions.
    readonly homeOf: (id: string) => string;
    // Moves a home a sign-in just filled into place as this account's, replacing whatever it held.
    readonly adopt: (id: string, signedIn: string) => Promise<void>;
    readonly logger: Logger;
}

export const cliStoreDir = (authRoot: string, cli: Pick<VendorCli, "authDir">): string => join(authRoot, cli.authDir);

// Row name: what the user typed, else who the CLI says this is, else the program's own name.
const displayLabel = (cli: Pick<VendorCli, "name">, stored: Pick<StoredCliAccount, "label" | "email">): string =>
    stored.label?.trim() || stored.email || cli.name;

// The account-list view, in the shape every provider's row takes; `variant` names the loop door it signs in, which is
// how a picker knows these rows serve the CLI's loop and not the provider's other credential.
export const cliAccountRow = (cli: Pick<VendorCli, "name" | "door">, stored: StoredCliAccount): OauthAccount => {
    const refused = stored.refusedAt !== undefined;
    return {
        id: stored.id,
        label: displayLabel(cli, stored),
        connectedAt: stored.connectedAt,
        variant: cli.door,
        ...opt("email", stored.email),
        ...opt("needsReauth", refused ? true : undefined),
        ...opt("detail", refused ? `${cli.name} could no longer renew this sign-in. Connect it again to keep running turns on it.` : undefined),
    };
};

// Files of this shape only, shared with the pack predicate so a stray file cannot make a signed-out sandbox look signed in.
export const readCliAccounts = (dir: string): Promise<StoredCliAccount[]> => accountFiles(dir, StoredAccountSchema).list();

export const fileCliStore = (dir: string, cli: Pick<VendorCli, "name" | "door">, logger: Logger): CliStore => {
    const files = accountFiles(dir, StoredAccountSchema);
    const homeOf = (id: string): string => join(dir, "homes", id);
    return {
        logger,
        read: files.read,
        write: files.write,
        clear: async (id) => {
            await files.remove(id);
            await rm(homeOf(id), { recursive: true, force: true });
        },
        list: async () => (await files.list()).map((stored) => cliAccountRow(cli, stored)),
        accounts: files.list,
        homeOf,
        adopt: async (id, signedIn) => {
            await mkdir(join(dir, "homes"), { recursive: true, mode: 0o700 });
            await rm(homeOf(id), { recursive: true, force: true });
            await rename(signedIn, homeOf(id));
        },
    };
};

// Accounts a turn could run on, oldest connection first (first connected is the default where nothing else decides).
export const liveCliAccounts = async (store: Pick<CliStore, "accounts">): Promise<StoredCliAccount[]> =>
    (await store.accounts()).filter((account) => account.refusedAt === undefined);
