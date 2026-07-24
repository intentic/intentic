import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OauthAccount } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { Config } from "../env.config.js";

/* Kimi (Moonshot) credentials — the sandbox OWNS them, an API key rather than an OAuth grant. Kimi has no
 * device/PKCE handshake: the user pastes a key from their Moonshot account and the sandbox stores it beside the
 * workspace (outside the three repos, so it's never committed), one file per account. Unlike Claude/Grok there
 * is no refresh — a key is used until the user disconnects it. The key is the bearer the Claude Code harness
 * sends to Moonshot's Anthropic-compatible endpoint (see agent.routes). */

// The persisted account: the API key tagged with account identity. Stored under the store dir, one file each.
// A schema rather than a bare interface because reads are PARSED, not trusted: the store dir also holds the
// catalog's models.json, so an unparsed read surfaces every stray .json as a blank account in the picker.
const StoredKimiAccountSchema = z.object({
    id: z.string(),
    label: z.string(),
    apiKey: z.string(),
    connectedAt: z.number(), // epoch ms
});
export type StoredKimiAccount = z.infer<typeof StoredKimiAccountSchema>;

// The metadata view (no key) the account list surfaces — the same shape every provider's `/accounts` returns.
const toAccount = (stored: StoredKimiAccount): OauthAccount => ({ id: stored.id, label: stored.label, connectedAt: stored.connectedAt });

// Tag a freshly-pasted key with a new account identity for storage.
export const newKimiAccount = (apiKey: string, label: string): StoredKimiAccount => ({
    id: randomUUID(),
    label: label.trim() !== "" ? label.trim() : "Kimi",
    apiKey: apiKey.trim(),
    connectedAt: Date.now(),
});

// The credential store, injected so the daemon's tests need no filesystem. Keyed by account id — a sandbox can
// hold several Kimi keys side by side.
export interface KimiStore {
    readonly read: (id: string) => Promise<StoredKimiAccount | undefined>;
    readonly write: (account: StoredKimiAccount) => Promise<void>;
    readonly clear: (id: string) => Promise<void>;
    readonly list: () => Promise<OauthAccount[]>;
}

// A JSON file store: one <id>.json per account under <authRoot>/kimi/ (outside the three repos).
export const fileKimiStore = (dir: string): KimiStore => {
    const path = (id: string): string => join(dir, `${id}.json`);
    const readStored = async (id: string): Promise<StoredKimiAccount | undefined> => {
        try {
            const parsed = StoredKimiAccountSchema.safeParse(JSON.parse(await readFile(path(id), "utf8")));
            return parsed.success ? parsed.data : undefined;
        } catch {
            return undefined;
        }
    };
    return {
        read: readStored,
        write: async (account) => {
            await mkdir(dir, { recursive: true });
            await writeFile(path(account.id), `${JSON.stringify(account, undefined, 2)}\n`);
        },
        clear: (id) => rm(path(id), { force: true }),
        list: async () => {
            const entries = await readdir(dir).catch(() => [] as string[]);
            const stored = await Promise.all(entries.filter((name) => name.endsWith(".json")).map((name) => readStored(name.slice(0, -5))));
            return stored
                .filter((account): account is StoredKimiAccount => account !== undefined)
                .map(toAccount)
                .toSorted((a, b) => a.connectedAt - b.connectedAt);
        },
    };
};

// The usable Kimi API key for a turn (or catalog discovery): the selected account's key, else the first stored
// account's, else the container MOONSHOT_API_KEY fallback (a bare dev run). undefined ⇒ Kimi can't run — the
// caller surfaces an actionable "connect your Kimi key" error. `accountId` picks a specific stored account.
export const resolveKimiKey = async (
    store: KimiStore,
    config: Config,
    accountId?: string,
): Promise<{ apiKey: string; accountId?: string } | undefined> => {
    const id = accountId ?? (await store.list())[0]?.id;
    if (id !== undefined) {
        const account = await store.read(id);
        if (account !== undefined) {
            return { apiKey: account.apiKey, accountId: id };
        }
    }
    return config.moonshotApiKey !== "" ? { apiKey: config.moonshotApiKey } : undefined;
};
