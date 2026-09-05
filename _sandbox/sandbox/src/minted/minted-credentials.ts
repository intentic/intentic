import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MintedProvider, OauthAccount } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";

/* THE ACCOUNTS OF A MINTED PROVIDER, and the store is deliberately the dullest one in this daemon.
 *
 * The Cursor store's shape (one JSON file per account under the auth root, several accounts side by side, the
 * credential never on the wire) with everything about ROTATION removed, because there is nothing here that
 * rotates: the key a sign-in minted is static until the user signs in again. That is the whole difference, and
 * it is why this is one small file rather than a second copy of claude-credentials.ts.
 *
 * ONE STORE, EVERY MINTED PROVIDER. The directory is the provider id and nothing else varies, so Meta and Z.ai
 * share this implementation and a third minted provider costs a spec row and its login. The alternative — one
 * credential module per provider, identical but for a string — is exactly the duplication the provider registry
 * was built to stop, one layer down.
 *
 * NO EXPIRY, AND NO `needsReauth`. Neither vendor's minted key announces a lifetime, so inventing a warning
 * window for it (the way Cursor's minted key genuinely has one) would be the UI asserting a fact nobody told it.
 * A key the vendor has revoked shows up the only way it can: the turn is refused, and the refusal names the
 * provider.
 *
 * WHAT `variant` IS FOR, and it is the one field here that a turn cannot run without. Z.ai sells the same plan
 * through two separate estates: an international key works against api.z.ai and a mainland one against
 * open.bigmodel.cn, and each host refuses the other's credential. The sign-in knows which estate it just used,
 * so it records it, and the turn and the catalog dial the host that key belongs to (mintedVariant, in the
 * contract). Guessing per provider would send half of Z.ai's users' turns to a host that has never heard of
 * their key, and the refusal would read as "your credential is bad".
 *
 * WHAT `email` IS FOR. Nothing in a minted key says whose it is, but the sign-in that minted it usually does
 * (Meta's token carries the account, Z.ai's poll answers with the user), so the row names itself the way an
 * OAuth account does. The connect form no longer asks for a name up front — there is nothing to type it beside —
 * and `rename` is still there for the person holding two plans on one estate. */

const StoredKeySchema = z.object({
    id: z.string().min(1),
    // What the user renamed it to. Absent ⇒ the row falls back to the sign-in identity, then the provider name.
    label: z.string().optional(),
    // Who the sign-in was as, where the vendor said. Absent ⇒ it told us nothing, which is when renaming is the
    // only way to tell two rows apart.
    email: z.string().optional(),
    // Which of the provider's estates minted this key, and therefore which hosts it is good against.
    variant: z.string().min(1),
    apiKey: z.string().min(1),
    connectedAt: z.number(),
});
export type StoredKeyAccount = z.infer<typeof StoredKeySchema>;

// The name a row carries: what the user renamed it to, else who it signed in as, else the provider's own name.
// Derived on every read, never stored, the Claude and Cursor rule, so clearing a label restores the fallback
// rather than leaving a nameless row.
export const mintedDisplayLabel = (stored: Pick<StoredKeyAccount, "label" | "email">, providerName: string): string =>
    stored.label?.trim() || stored.email?.trim() || providerName;

/* The metadata view the account list surfaces, with the key removed. It is not that the key is stripped here:
 * OauthAccount has no field it could travel in, which is the property that makes "did this route leak the
 * credential" answerable by reading a type instead of an implementation.
 *
 * `usage` is deliberately never set. Neither vendor publishes an account-wide allowance their minted key can
 * read, so a ring here would be inventing a denominator; an absent reading already means "unknown" everywhere
 * that draws these rows, and the provider's spec says `planLimits: false` so nothing goes looking for one. */
export const toMintedAccount = (stored: StoredKeyAccount, providerName: string): OauthAccount => ({
    id: stored.id,
    label: mintedDisplayLabel(stored, providerName),
    ...(stored.email !== undefined ? { email: stored.email } : {}),
    connectedAt: stored.connectedAt,
});

export interface MintedStore {
    // Every connected account of this provider, as rows a surface may render. Cannot carry the key.
    readonly list: () => Promise<OauthAccount[]>;
    // The stored accounts themselves, keys included. Only the turn path and the catalog call this.
    readonly credentials: () => Promise<StoredKeyAccount[]>;
    // Record what a sign-in minted as a new account, answering with the row it became.
    readonly connect: (input: {
        readonly apiKey: string;
        readonly variant: string;
        readonly email?: string;
    }) => Promise<OauthAccount>;
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
 * stray JSON in the same directory cannot make a provider with no credential report itself connected. Oldest
 * first, so the row order a user sees is the order they connected them in. */
export const readMintedCredentials = async (dir: string): Promise<StoredKeyAccount[]> => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const stored = await Promise.all(entries.filter((name) => name.endsWith(".json")).map((name) => readCredential(dir, name.slice(0, -5))));
    return stored.filter((account): account is StoredKeyAccount => account !== undefined).toSorted((a, b) => a.connectedAt - b.connectedAt);
};

// A JSON file store: one <id>.json per account under <workspace>/.intentic/secrets/auth/<provider>/. That whole
// tree is already classified `secret` by construction (workspace-state.ts), so a new provider directory under
// it is fenced from search, export and the file routes without naming it anywhere.
export const fileMintedStore = (input: {
    readonly dir: string;
    readonly provider: MintedProvider;
    readonly providerName: string;
    readonly logger: Logger;
}): MintedStore => {
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
    /* CONNECTS RUN ONE AT A TIME, because the stamp a connect takes is read from what is already on disk. Two
     * connects landing together would both read the same newest row and both land on the same tick, which is the
     * tie the stamp exists to prevent — and "together" is not exotic here: two sign-ins on two estates can be
     * approved in the same second, and a scripted seed lands both keys of a plan at once. The queue makes
     * read-then-write one step. Only connect needs it; a rename keeps the stamp it found and a disconnect
     * removes a file by name. */
    let queue: Promise<unknown> = Promise.resolve();
    const serialized = <T>(step: () => Promise<T>): Promise<T> => {
        // Both arms are `step`, so one caller's rejection does not cancel the next one's turn.
        const next = queue.then(step, step);
        queue = next.catch(() => undefined);
        return next;
    };
    return {
        list: async () => (await readMintedCredentials(dir)).map((stored) => toMintedAccount(stored, providerName)),
        credentials: () => readMintedCredentials(dir),
        connect: ({ apiKey, variant, email }) =>
            serialized(async () => {
                /* A MINT TAKES NO TIME once the user has approved, so two connects can land in the same
                 * millisecond. Equal stamps leave "oldest first" to whatever order readdir hands back for two
                 * random UUID filenames, which is arbitrary — and the account list, and the tiebreak
                 * harness-credentials uses to pick between equal accounts, both read that order. So a new
                 * credential is stamped at least one tick past the newest one already stored: the connect order
                 * stays recoverable from the files alone, without inventing a sub-millisecond clock.
                 * Ordered oldest first, so the last row is the newest stamp. */
                const newest = (await readMintedCredentials(dir)).at(-1)?.connectedAt ?? 0;
                const account: StoredKeyAccount = {
                    id: randomUUID(),
                    apiKey: apiKey.trim(),
                    variant,
                    connectedAt: Math.max(Date.now(), newest + 1),
                    ...(email !== undefined && email.trim() !== "" ? { email: email.trim() } : {}),
                };
                await write(account);
                input.logger.info({ provider: input.provider, account: account.id, variant }, "minted provider connected");
                return toMintedAccount(account, providerName);
            }),
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
            return toMintedAccount(renamed, providerName);
        },
        disconnect: async (id) => {
            await rm(credentialPath(dir, id), { force: true });
        },
    };
};
