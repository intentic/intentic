import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeyProvider, OauthAccount } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";

/* THE ACCOUNTS OF A KEYED PROVIDER, and the store is deliberately the dullest one in this daemon.
 *
 * The Cursor store's shape (one JSON file per account under the auth root, several accounts side by side, the
 * credential never on the wire) with everything about ROTATION removed, because there is nothing here that
 * rotates: an API key the user pasted is static until they replace it. That is the whole difference, and it is
 * why this is one small file rather than a second copy of claude-credentials.ts.
 *
 * ONE STORE, EVERY KEYED PROVIDER. The directory is the provider id and nothing else varies, so Meta and Z.ai
 * share this implementation and a third keyed provider costs a spec row. The alternative — one credential
 * module per keyed provider, identical but for a string — is exactly the duplication the provider registry
 * was built to stop, one layer down.
 *
 * NO EXPIRY, AND NO `needsReauth`. A pasted key does not announce a lifetime, so inventing a warning window for
 * it (the way Cursor's minted key genuinely has one) would be the UI asserting a fact nobody told it. A key the
 * vendor has revoked shows up the only way it can: the turn is refused, and the refusal names the provider.
 *
 * WHAT `label` IS FOR. Nothing in a pasted key says whose it is, so unlike an OAuth account there is no
 * sign-in identity to derive a name from. A person with two Z.ai plans has two rows that would otherwise both
 * read "Z.ai", so the connect form takes a name and the fallback is the provider's own, which at least keeps
 * the row from being blank. */

const StoredKeySchema = z.object({
    id: z.string().min(1),
    // What the user typed when connecting, or renamed it to. Absent ⇒ the row falls back to the provider name.
    label: z.string().optional(),
    apiKey: z.string().min(1),
    connectedAt: z.number(),
});
export type StoredKeyAccount = z.infer<typeof StoredKeySchema>;

// The name a row carries: what the user typed, else the provider's own name. Derived on every read, never
// stored, the Claude and Cursor rule, so clearing a label restores the fallback rather than leaving a
// nameless row.
export const keyedDisplayLabel = (stored: Pick<StoredKeyAccount, "label">, providerName: string): string => stored.label?.trim() || providerName;

/* The metadata view the account list surfaces, with the key removed. It is not that the key is stripped here:
 * OauthAccount has no field it could travel in, which is the property that makes "did this route leak the
 * credential" answerable by reading a type instead of an implementation.
 *
 * `usage` is deliberately never set. Neither vendor publishes an account-wide allowance a stored key can read,
 * so a ring here would be inventing a denominator; an absent reading already means "unknown" everywhere that
 * draws these rows, and the provider's spec says `planLimits: false` so nothing goes looking for one. */
export const toKeyedAccount = (stored: StoredKeyAccount, providerName: string): OauthAccount => ({
    id: stored.id,
    label: keyedDisplayLabel(stored, providerName),
    connectedAt: stored.connectedAt,
});

export interface KeyedStore {
    // Every connected account of this provider, as rows a surface may render. Cannot carry the key.
    readonly list: () => Promise<OauthAccount[]>;
    // The stored accounts themselves, keys included. Only the turn path and the catalog call this.
    readonly credentials: () => Promise<StoredKeyAccount[]>;
    // Store a pasted key as a new account, answering with the row it became.
    readonly connect: (input: { readonly apiKey: string; readonly label?: string }) => Promise<OauthAccount>;
    // Rename one account. Blank restores the derived name. Undefined ⇒ no such account.
    readonly rename: (id: string, label: string) => Promise<OauthAccount | undefined>;
    readonly disconnect: (id: string) => Promise<void>;
}

const credentialPath = (dir: string, id: string): string => join(dir, `${id}.json`);

const readCredential = async (dir: string, id: string): Promise<StoredKeyAccount | undefined> => {
    try {
        const parsed = StoredKeySchema.safeParse(JSON.parse(await readFile(credentialPath(dir, id), "utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
};

/* The credential files that actually have this shape. Shared with the readiness rung, so a cache file or a
 * stray JSON in the same directory cannot make a provider with no key report itself connected. Oldest first,
 * so the row order a user sees is the order they connected them in. */
export const readKeyedCredentials = async (dir: string): Promise<StoredKeyAccount[]> => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const stored = await Promise.all(entries.filter((name) => name.endsWith(".json")).map((name) => readCredential(dir, name.slice(0, -5))));
    return stored.filter((account): account is StoredKeyAccount => account !== undefined).toSorted((a, b) => a.connectedAt - b.connectedAt);
};

// A JSON file store: one <id>.json per account under <workspace>/.intentic/secrets/auth/<provider>/. That whole
// tree is already classified `secret` by construction (workspace-state.ts), so a new provider directory under
// it is fenced from search, export and the file routes without naming it anywhere.
export const fileKeyedStore = (input: {
    readonly dir: string;
    readonly provider: KeyProvider;
    readonly providerName: string;
    readonly logger: Logger;
}): KeyedStore => {
    const { dir, providerName } = input;
    // Atomic, the Claude precedent: a reader (this daemon, the account list, another sandbox on a shared auth
    // dir) must never observe a half-written file, because an unparseable read degrades to "no such account",
    // which looks to the user like a credential that disconnected itself.
    const write = async (account: StoredKeyAccount): Promise<void> => {
        await mkdir(dir, { recursive: true });
        const path = credentialPath(dir, account.id);
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, `${JSON.stringify(account, undefined, 2)}\n`, { mode: 0o600 });
        await rename(temp, path);
    };
    return {
        list: async () => (await readKeyedCredentials(dir)).map((stored) => toKeyedAccount(stored, providerName)),
        credentials: () => readKeyedCredentials(dir),
        connect: async ({ apiKey, label }) => {
            /* A PASTE TAKES NO TIME, so two connects land in the same millisecond routinely (a form submitted
             * twice, a script seeding both keys of a plan). Equal stamps leave "oldest first" to whatever order
             * readdir hands back for two random UUID filenames, which is arbitrary — and the account list, and
             * the tiebreak harness-credentials uses to pick between equal accounts, both read that order. So a
             * new key is stamped at least one tick past the newest one already stored: the connect order stays
             * recoverable from the files alone, without inventing a sub-millisecond clock.
             * Ordered oldest first, so the last row is the newest stamp. */
            const newest = (await readKeyedCredentials(dir)).at(-1)?.connectedAt ?? 0;
            const account: StoredKeyAccount = {
                id: randomUUID(),
                apiKey: apiKey.trim(),
                connectedAt: Math.max(Date.now(), newest + 1),
                ...(label !== undefined && label.trim() !== "" ? { label: label.trim() } : {}),
            };
            await write(account);
            input.logger.info({ provider: input.provider, account: account.id }, "keyed provider connected");
            return toKeyedAccount(account, providerName);
        },
        rename: async (id, label) => {
            const stored = await readCredential(dir, id);
            if (stored === undefined) {
                return undefined;
            }
            // A blank label CLEARS rather than stores an empty string, so the row goes back to the derived name
            // instead of rendering as nothing. The same rule the Claude and Cursor stores follow.
            const { label: _dropped, ...rest } = stored;
            const renamed: StoredKeyAccount = label.trim() === "" ? rest : { ...rest, label: label.trim() };
            await write(renamed);
            return toKeyedAccount(renamed, providerName);
        },
        disconnect: async (id) => {
            await rm(credentialPath(dir, id), { force: true });
        },
    };
};
