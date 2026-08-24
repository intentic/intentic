import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { OauthAccount } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { ensureCursorSdk } from "./cursor-sdk.js";

/* CURSOR ACCOUNTS, AND THE SIGN-IN THAT MINTS THEM. The Claude store's shape (one JSON file per account under
 * the auth root, several accounts side by side, tokens never on the wire) with the whole refresh apparatus
 * removed, because Cursor's credential does not rotate.
 *
 * WHAT IS STORED IS A USER API KEY, not the session that produced it, and that is Cursor's design rather than
 * ours: `Cursor.auth.login()` uses the session token exactly once, to mint a named key with an expiry, then
 * drops it. The key is the narrower credential — revocable and visible in Cursor's own dashboard API-keys
 * list — where the session token would grant the whole account. Naming the key after this sandbox is
 * therefore not decoration: it is the only way an owner looking at that dashboard can tell which of their
 * machines a key belongs to, and revoke one without revoking the rest.
 *
 * NO REFRESH, SO NO LOCK. A Claude account needs a cross-process refresh lock because two daemons sharing an
 * auth dir can each try to redeem the same refresh token and get the whole family revoked. A Cursor key is
 * static for its ~90 days: concurrent readers are just readers, and when it does expire the only repair is a
 * new sign-in. So expiry is REPORTED (needsReauth, the row the account list already knows how to draw) rather
 * than handled.
 *
 * WHY THE SDK'S OWN CREDENTIAL STORE IS NOT USED. `SdkCredentialStore` is single-slot by construction —
 * `load()` takes no key — because it models one machine holding one login. A sandbox holds as many accounts as
 * the owner connects, so the login runs with `store: null` and the result is written here instead, and every
 * SDK call is handed its account's `apiKey` explicitly. That also keeps the credential out of `~/.cursor`,
 * where nothing fences it. */

const StoredAccountSchema = z.object({
    id: z.string().min(1),
    // What the user typed, when they have renamed it. Absent ⇒ the row derives its name (see displayLabel).
    label: z.string().optional(),
    // Who Cursor says this is. Absent when the identity lookup did not answer, which is exactly when renaming
    // is the only way to tell two rows apart.
    email: z.string().optional(),
    apiKey: z.string().min(1),
    // Epoch ms. Absent would mean a key that never expires; the login always sets one, so this is effectively
    // always present, and optional only because it is the provider's field to send.
    apiKeyExpiresAtMs: z.number().optional(),
    // The backend the key was minted against. Keys are backend-paired, so a key minted against a staging
    // backend is not usable against production and vice versa; stored so a mismatched sandbox can say so
    // instead of failing every call with an opaque 401.
    backendUrl: z.string().optional(),
    connectedAt: z.number(),
});
export type StoredCursorAccount = z.infer<typeof StoredAccountSchema>;

/* The name a row carries: what the user typed, else who Cursor says this is, else the provider's own name.
 * Derived on every read, never stored, the Claude rule, and for the same reason: "Cursor" is a true and
 * useless answer to "which account is this?". */
export const displayLabel = (stored: Pick<StoredCursorAccount, "label" | "email">): string => stored.label?.trim() || stored.email || "Cursor";

/* How long before a key's expiry the row starts saying so. A Cursor key cannot be renewed in place, so this is
 * not a refresh window but a WARNING one: the point is that an owner meets "sign in again" while they are
 * looking at a settings page, rather than in the middle of a turn a week later. Three days is long enough to
 * be noticed on a normal working week and short enough not to nag for a quarter. */
const EXPIRY_WARNING_MS = 3 * 24 * 60 * 60_000;

// Expired, or close enough that the next long turn might outlive it. Kept as one predicate because both
// answers put the same row on screen, only the sentence differs.
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

/* The metadata view the account list surfaces, with the key removed. An expiring key rides out as the same
 * needsReauth/detail pair Codex and Claude use, so the picker, the Setup row and the connect gate light up
 * unchanged for a third provider they know nothing specific about.
 *
 * `usage` is deliberately never set. Cursor publishes per-turn tokens and cost through the SDK but no
 * account-wide allowance, so a ring here would be inventing a denominator; an absent reading already means
 * "unknown" everywhere that draws these rows, which is the truth. */
export const toAccount = (stored: StoredCursorAccount): OauthAccount => {
    const note = expiryNote(stored);
    const expired = stored.apiKeyExpiresAtMs !== undefined && stored.apiKeyExpiresAtMs <= Date.now();
    return {
        id: stored.id,
        label: displayLabel(stored),
        connectedAt: stored.connectedAt,
        ...(stored.email !== undefined ? { email: stored.email } : {}),
        // needsReauth only once it is actually dead: a key with two days left still runs every turn asked of
        // it, and flagging it as broken would send someone to reconnect a credential that works. The note goes
        // out either way, which is the difference between warning and refusing.
        ...(expired ? { needsReauth: true } : {}),
        ...(note !== undefined ? { detail: note } : {}),
    };
};

export interface CursorStore {
    readonly read: (id: string) => Promise<StoredCursorAccount | undefined>;
    readonly write: (account: StoredCursorAccount) => Promise<void>;
    readonly clear: (id: string) => Promise<void>;
    readonly list: () => Promise<OauthAccount[]>;
    // The stored accounts themselves, keys included. Only the turn path and the catalog call this; everything
    // user-facing goes through `list`, which cannot leak a key because its shape has no field for one.
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

/* The credential files that actually have Cursor's account shape. Shared with the provider-pack predicate so
 * a cache or foreign JSON file in the same directory cannot make a disconnected sandbox retain the runtime. */
export const readCursorCredentials = async (dir: string): Promise<StoredCursorAccount[]> => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const stored = await Promise.all(
        entries.filter((name) => name.endsWith(".json")).map((name) => readCursorCredential(dir, name.slice(0, -5))),
    );
    return stored.filter((account): account is StoredCursorAccount => account !== undefined).toSorted((a, b) => a.connectedAt - b.connectedAt);
};

// A JSON file store: one <id>.json per account under <workspace>/.intentic/secrets/auth/cursor/. That whole
// tree is already classified `secret` by construction (workspace-state.ts), so a new provider directory under
// it is fenced from search, export and the file routes without naming it anywhere.
export const fileCursorStore = (dir: string, logger: Logger): CursorStore => {
    return {
        logger,
        read: (id) => readCursorCredential(dir, id),
        // Atomic, the Claude precedent: a reader (this daemon, the account list, another sandbox on a shared
        // auth dir) must never observe a half-written file, because an unparseable read degrades to "no such
        // account", which looks to the user like a credential that disconnected itself.
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

/* ---- the sign-in ------------------------------------------------------------------------------------------
 *
 * Cursor's login is PKCE, and its verifier is redeemable on its own: anyone holding it plus the handshake id
 * can complete the sign-in and mint a durable key. So unlike Claude's paste-back flow, no part of this
 * handshake is allowed onto the wire. The daemon starts the flow, keeps the verifier inside the SDK call it
 * owns, polls Cursor itself, and writes the account when the browser completes. The caller gets a URL and a
 * cancellation handle, and learns the outcome by watching the account list, which is the same thing a device
 * login asks of it. */

// What a caller may still cancel, by handshake id. In memory on purpose: a daemon restart drops any sign-in
// that was in flight, which is correct, the poll it was running died with the process, and the browser tab
// that was going to complete it is now completing nothing.
const pending = new Map<string, { readonly abort: AbortController; readonly expiresAt: number }>();

/* How long an unanswered attempt stays answerable. The SDK's own poll gives up at roughly twenty minutes; this
 * is deliberately a little under, so the card stops waiting because THIS said to, with a sentence, rather than
 * because a promise somewhere rejected with a timeout nobody chose. */
const LOGIN_WINDOW_MS = 18 * 60_000;

export interface CursorLoginDeps {
    readonly store: CursorStore;
    // Names the minted key in Cursor's dashboard, so an owner can tell this sandbox's key from their laptop's.
    readonly keyName: string;
    // Recompose after the credential lands: on every published image this is what makes the just-bootstrapped
    // SDK durable across the next container recreation.
    readonly connected: () => Promise<unknown>;
}

export interface StartedLogin {
    readonly url: string;
    readonly handshake: string;
    readonly expiresAt: number;
}

/* Begin a sign-in. Resolves as soon as Cursor hands back the page to open; the rest (the poll, the mint, the
 * write) continues in the background and lands as a new row in the account list.
 *
 * THE BACKGROUND HALF NEVER REJECTS INTO NOTHING. It is a floating promise by design — the route has already
 * answered — so every outcome is either a written account or a logged line, and the cancelled case is not
 * logged as a failure because a person closing a tab is not an error. */
export const startCursorLogin = async (deps: CursorLoginDeps): Promise<StartedLogin> => {
    const sdk = await ensureCursorSdk();
    const handshake = randomUUID();
    const abort = new AbortController();
    const expiresAt = Date.now() + LOGIN_WINDOW_MS;
    pending.set(handshake, { abort, expiresAt });
    const timer = setTimeout(() => abort.abort(), LOGIN_WINDOW_MS);
    timer.unref();

    // The URL arrives through a callback rather than a return value, so the route is unblocked by the first
    // thing the flow produces instead of by the whole flow finishing (which is a person, minutes from now).
    const url = await new Promise<string>((settle, fail) => {
        const login = sdk.Cursor.auth
            .login({
                openBrowser: false,
                onLoginUrl: settle,
                signal: abort.signal,
                // Written here, not in ~/.cursor: this sandbox holds many accounts and that store holds one.
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
        // A flow that dies BEFORE producing a URL (no network, a backend that refuses) would otherwise leave
        // this promise pending forever and the route hanging with it.
        void login.then(() => {
            fail(new Error("Cursor did not hand back a sign-in page."));
        });
    });
    return { url, handshake, expiresAt };
};

// Stop waiting on a sign-in nobody completed. Unknown ids are a no-op rather than an error: the attempt has
// already expired or already landed, and both are the state the caller was asking for.
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

/* THE ACCOUNT A TURN SHOULD SPEND, given what the turn asked for. A named account that is still usable wins;
 * otherwise the oldest usable one, which is the same "first connected is the default" rule the other providers
 * follow. Undefined ⇒ nothing connected can serve, and the caller turns that into the refusal that says so.
 *
 * EXPIRY IS PART OF USABLE, and this is the one place it gates rather than warns. Sending a turn at a dead key
 * spends the user's time to arrive at a 401 the adapter would have to translate back into "sign in again",
 * when the store already knew. */
export const usableCursorAccount = async (store: CursorStore, requested: string | undefined): Promise<StoredCursorAccount | undefined> => {
    const usable = (await store.credentials()).filter((account) => account.apiKeyExpiresAtMs === undefined || account.apiKeyExpiresAtMs > Date.now());
    if (requested !== undefined && requested !== "") {
        return usable.find((account) => account.id === requested);
    }
    return usable[0];
};
