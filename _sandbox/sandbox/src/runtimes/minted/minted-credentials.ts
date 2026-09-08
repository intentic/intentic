import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MintedProvider, OauthAccount } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";

// Accounts of a minted provider, one store shared by every provider: rotation removed, since a minted key is static
// until re-sign-in. No expiry/needsReauth: a revoked key only shows up as a refused turn. `variant` records which
// estate minted the key, since e.g. Z.ai's two hosts refuse each other's credential; `email` comes from the sign-in,
// nothing in the key itself names an owner.

const StoredKeySchema = z.object({
    id: z.string().min(1),
    // What the user renamed it to. Absent ⇒ the row falls back to the sign-in identity, then the provider name.
    label: z.string().optional(),
    // Who the sign-in was as, where the vendor said; absent means renaming is the only way to tell two rows apart.
    email: z.string().optional(),
    // Which of the provider's estates minted this key, and therefore which hosts it is good against.
    variant: z.string().min(1),
    apiKey: z.string().min(1),
    connectedAt: z.number(),
});
export type StoredKeyAccount = z.infer<typeof StoredKeySchema>;

// Row name: user rename, else sign-in identity, else provider name. Derived on every read, never stored, so clearing a
// label restores the fallback.
export const mintedDisplayLabel = (stored: Pick<StoredKeyAccount, "label" | "email">, providerName: string): string =>
    stored.label?.trim() || stored.email?.trim() || providerName;

// OauthAccount has no field the key could travel in, so leak-checking is a type question, not an implementation one.
// `usage` stays unset: neither vendor publishes an allowance to read, and the spec says `planLimits: false`.
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

// Only the files with this shape count, so a stray JSON (e.g. the catalog cache) can't make an unconnected provider
// report itself connected. Oldest first, matching connect order.
export const readMintedCredentials = async (dir: string): Promise<StoredKeyAccount[]> => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const stored = await Promise.all(entries.filter((name) => name.endsWith(".json")).map((name) => readCredential(dir, name.slice(0, -5))));
    return stored.filter((account): account is StoredKeyAccount => account !== undefined).toSorted((a, b) => a.connectedAt - b.connectedAt);
};

// One <id>.json per account under .intentic/secrets/auth/<provider>/; that tree is already classified secret
// (workspace-state.ts), so a new provider directory is fenced without naming it anywhere.
export const fileMintedStore = (input: {
    readonly dir: string;
    readonly provider: MintedProvider;
    readonly providerName: string;
    readonly logger: Logger;
}): MintedStore => {
    const { dir, providerName } = input;
    // Atomic write: a reader must never observe a half-written file, since an unparseable read degrades to "no such
    // account", looking like a self-disconnected credential.
    const write = async (account: StoredKeyAccount): Promise<void> => {
        await mkdir(dir, { recursive: true });
        const path = credentialPath(dir, account.id);
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, `${JSON.stringify(account, undefined, 2)}\n`, { mode: 0o600 });
        await rename(temp, path);
    };
    // Connects run one at a time: the stamp is read from what's already on disk, and two landing together (two estates
    // approved the same second, a scripted seed) would tie. Only connect needs the queue; rename keeps its stamp,
    // disconnect removes by name.
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
                // A mint takes no time, so two connects can land in the same millisecond; equal stamps would leave
                // order to readdir's arbitrary filename sort. Each new credential is stamped at least one tick past the
                // newest stored one, keeping connect order recoverable from the files alone.
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
            // A blank label clears rather than stores an empty string, so the row falls back to the derived name.
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
