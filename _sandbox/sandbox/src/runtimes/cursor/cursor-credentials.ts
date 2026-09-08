import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { OauthAccount } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { ensureCursorSdk } from "./cursor-sdk.js";

// Cursor accounts, one JSON file per account under the auth root; no refresh, since Cursor's key doesn't rotate. Stores
// the minted user API key, not the session that produced it: login mints it once, then drops the session. The SDK's own
// store is single-slot, so login runs with store: null and this file store holds every account instead.

const StoredAccountSchema = z.object({
    id: z.string().min(1),
    // What the user typed, if renamed; absent means the row derives its name (see displayLabel).
    label: z.string().optional(),
    // Who Cursor says this is; absent when identity lookup didn't answer, the case renaming exists for.
    email: z.string().optional(),
    apiKey: z.string().min(1),
    // Epoch ms; optional only because it's the provider's field, login always sets one in practice.
    apiKeyExpiresAtMs: z.number().optional(),
    // Backend the key was minted against; a mismatch can be reported instead of failing every call with a bare 401.
    backendUrl: z.string().optional(),
    connectedAt: z.number(),
});
export type StoredCursorAccount = z.infer<typeof StoredAccountSchema>;

// Row name: what the user typed, else who Cursor says this is, else "Cursor". Derived on every read, never stored.
export const displayLabel = (stored: Pick<StoredCursorAccount, "label" | "email">): string => stored.label?.trim() || stored.email || "Cursor";

// Warning window before expiry, not a refresh window (a Cursor key can't be renewed in place); three days.
const EXPIRY_WARNING_MS = 3 * 24 * 60 * 60_000;

// Expired or close enough that a long turn might outlive it; one predicate since both cases mark the same row, only the
// sentence differs.
const expiryNote = (stored: StoredCursorAccount): string | undefined => {
    if (stored.apiKeyExpiresAtMs === undefined) {
        return undefined;
    }
    const left = stored.apiKeyExpiresAtMs - Date.now();
    if (left <= 0) {
        return "This sign-in has expired. Connect it again to keep running turns on it.";
    }
    return left <= EXPIRY_WARNING_MS ? `This sign-in expires in under ${Math.max(1, Math.ceil(left / (24 * 60 * 60_000)))} days.` : undefined;
};

// Account-list view with the key removed; needsReauth/detail match Codex/Claude's shape, so the UI needs nothing
// Cursor-specific. usage is never set: Cursor publishes no account-wide allowance, so absent already reads as unknown.
export const toAccount = (stored: StoredCursorAccount): OauthAccount => {
    const note = expiryNote(stored);
    const expired = stored.apiKeyExpiresAtMs !== undefined && stored.apiKeyExpiresAtMs <= Date.now();
    return {
        id: stored.id,
        label: displayLabel(stored),
        connectedAt: stored.connectedAt,
        ...(stored.email !== undefined ? { email: stored.email } : {}),
        // needsReauth only once the key is actually dead; a warning key still runs every turn asked of it.
        ...(expired ? { needsReauth: true } : {}),
        ...(note !== undefined ? { detail: note } : {}),
    };
};

export interface CursorStore {
    readonly read: (id: string) => Promise<StoredCursorAccount | undefined>;
    readonly write: (account: StoredCursorAccount) => Promise<void>;
    readonly clear: (id: string) => Promise<void>;
    readonly list: () => Promise<OauthAccount[]>;
    // Stored accounts with keys included; only the turn path and catalog call this, list() cannot leak one.
    readonly credentials: () => Promise<StoredCursorAccount[]>;
    readonly logger: Logger;
}

const cursorCredentialPath = (dir: string, id: string): string => join(dir, `${id}.json`);

const readCursorCredential = async (dir: string, id: string): Promise<StoredCursorAccount | undefined> => {
    try {
        const parsed = StoredAccountSchema.safeParse(JSON.parse(await readFile(cursorCredentialPath(dir, id), "utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
};

// Files with Cursor's own account shape; shared with the provider-pack predicate so a stray cache or foreign JSON can't
// make a disconnected sandbox look connected.
export const readCursorCredentials = async (dir: string): Promise<StoredCursorAccount[]> => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const stored = await Promise.all(
        entries.filter((name) => name.endsWith(".json")).map((name) => readCursorCredential(dir, name.slice(0, -5))),
    );
    return stored.filter((account): account is StoredCursorAccount => account !== undefined).toSorted((a, b) => a.connectedAt - b.connectedAt);
};

// One <id>.json per account under .intentic/secrets/auth/cursor/, already classified secret (workspace-state.ts):
// fenced from search, export and file routes without naming it.
export const fileCursorStore = (dir: string, logger: Logger): CursorStore => {
    return {
        logger,
        read: (id) => readCursorCredential(dir, id),
        // Atomic write (temp file + rename): a reader must never observe a half-written file, which would read as a
        // disconnected account.
        write: async (account) => {
            await mkdir(dir, { recursive: true });
            const path = cursorCredentialPath(dir, account.id);
            const temp = `${path}.${randomUUID()}.tmp`;
            await writeFile(temp, `${JSON.stringify(account, undefined, 2)}\n`, { mode: 0o600 });
            await rename(temp, path);
        },
        clear: async (id) => {
            await rm(cursorCredentialPath(dir, id), { force: true });
        },
        list: async () => (await readCursorCredentials(dir)).map(toAccount),
        credentials: () => readCursorCredentials(dir),
    };
};

// Cursor's login is PKCE; the verifier is redeemable on its own, so unlike Claude's paste-back flow no part of the
// handshake reaches the wire. The daemon holds the verifier, polls Cursor itself, and writes the account when the
// browser completes; the caller gets a URL and a cancel handle, and learns the outcome by watching the account list.

// Handshake id to cancel handle; in memory, so a daemon restart correctly drops any sign-in in flight.
const pending = new Map<string, { readonly abort: AbortController; readonly expiresAt: number }>();

// Answerable window; a little under the SDK's own ~20-minute poll, so the card times out with its own sentence.
const LOGIN_WINDOW_MS = 18 * 60_000;

export interface CursorLoginDeps {
    readonly store: CursorStore;
    // Names the minted key in Cursor's dashboard, so an owner can tell this sandbox's key from their laptop's.
    readonly keyName: string;
    // Recomposes after the credential lands, so the SDK bootstrap survives the next container recreation.
    readonly connected: () => Promise<unknown>;
}

export interface StartedLogin {
    readonly url: string;
    readonly handshake: string;
    readonly expiresAt: number;
}

// Resolves once Cursor hands back the page; the poll, mint and write continue in the background and land as a new row.
// Never rejects into nothing: it's a floating promise by design, and a cancelled sign-in isn't logged as a failure.
export const startCursorLogin = async (deps: CursorLoginDeps): Promise<StartedLogin> => {
    const sdk = await ensureCursorSdk();
    const handshake = randomUUID();
    const abort = new AbortController();
    const expiresAt = Date.now() + LOGIN_WINDOW_MS;
    pending.set(handshake, { abort, expiresAt });
    const timer = setTimeout(() => abort.abort(), LOGIN_WINDOW_MS);
    timer.unref();

    // URL arrives via callback so the route unblocks on the first thing the flow produces, not the whole flow
    // finishing.
    const url = await new Promise<string>((settle, fail) => {
        const login = sdk.Cursor.auth
            .login({
                openBrowser: false,
                onLoginUrl: settle,
                signal: abort.signal,
                // store: null: written here instead, since this sandbox holds many accounts and that store holds one.
                store: null,
                apiKeyName: deps.keyName,
            })
            .then(async (result) => {
                await deps.store.write({
                    id: handshake,
                    ...(result.email !== undefined ? { email: result.email } : {}),
                    apiKey: result.apiKey,
                    apiKeyExpiresAtMs: result.apiKeyExpiresAtMs,
                    connectedAt: Date.now(),
                });
                await deps.connected();
                deps.store.logger.info({ account: handshake }, "cursor: account connected");
            })
            .catch((error: unknown) => {
                if (abort.signal.aborted) {
                    deps.store.logger.info({ handshake }, "cursor: sign-in abandoned");
                    return;
                }
                deps.store.logger.warn({ err: error, handshake }, "cursor: sign-in failed");
            })
            .finally(() => {
                clearTimeout(timer);
                pending.delete(handshake);
            });
        // Rejects if the flow dies before producing a URL; otherwise this promise would hang forever with the route.
        void login.then(() => {
            fail(new Error("Cursor did not hand back a sign-in page."));
        });
    });
    return { url, handshake, expiresAt };
};

// Unknown ids are a no-op: the attempt already expired or already landed, both states the caller wanted.
export const cancelCursorLogin = (handshake: string): void => {
    pending.get(handshake)?.abort.abort();
    pending.delete(handshake);
};

// Abandon every in-flight sign-in, for daemon shutdown.
export const cancelAllCursorLogins = (): void => {
    for (const entry of pending.values()) {
        entry.abort.abort();
    }
    pending.clear();
};

// Named account if still usable wins; otherwise the oldest usable one (first-connected-is-default). The one place
// expiry gates rather than warns: a dead key would otherwise fail the turn with a 401 the store already knew.
export const usableCursorAccount = async (store: CursorStore, requested: string | undefined): Promise<StoredCursorAccount | undefined> => {
    const usable = (await store.credentials()).filter((account) => account.apiKeyExpiresAtMs === undefined || account.apiKeyExpiresAtMs > Date.now());
    if (requested !== undefined && requested !== "") {
        return usable.find((account) => account.id === requested);
    }
    return usable[0];
};
