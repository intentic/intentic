import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OauthAccount } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";

/* Claude subscription OAuth (PKCE) against the public Claude Code client — the sandbox OWNS these credentials
 * (the platform no longer holds them): the user authorizes once, the sandbox stores the tokens beside the
 * workspace and refreshes them on demand. The constants are unofficial/undocumented (they mirror what
 * `claude setup-token` uses) and may change. The redirect URI is Anthropic's hosted code-callback page (we
 * can't register our own), so the flow is: open the authorize URL → authorize → Anthropic shows `code#state`
 * → the caller pastes it back → we exchange it. The platform UI relays this handshake but stores nothing. */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

/* Anthropic ROTATES refresh tokens: every refresh mints a new one and retires the one presented. Present a
 * retired refresh token and that is reuse-detection — the authorization server revokes the whole token FAMILY
 * (RFC 9700 §4.14.2), including access tokens already handed out and still mid-turn. That is what
 * "401 OAuth access token has been revoked" means, and it kills every session at once rather than one at a
 * time, because they all carry tokens from the same family.
 *
 * So a refresh must happen at most once per rotation, across every caller AND every process: turns start in
 * bursts (a fleet of agents), the model catalog refreshes on its own hour-long timer, and AGENT_AUTH_DIR
 * points several dev sandboxes at ONE credential dir. Hence the two layers below — an in-process single-flight
 * map and a lock file in the store dir — and the re-read under the lock that lets a loser ADOPT the winner's
 * token instead of replaying a token that is already spent. Claude Code itself does the same thing
 * (`.oauth_refresh.lock`, and a "compromised CAS adopted sibling" path); running without it is what makes
 * intentic hit this where the VSCode extension never does. */

// Refresh this far ahead of the real expiry. Generous rather than last-second: the token is snapshotted into
// the agent subprocess env at spawn, so a turn that starts with only seconds of validity left has to recover
// mid-flight (see getOAuthToken in agent.ts) instead of simply never running dry.
const REFRESH_AHEAD_MS = 30 * 60_000;

// A refresh is one HTTPS round-trip. A lock older than this belongs to a process that died holding it.
const LOCK_STALE_MS = 30_000;
// How long a caller waits for the holder before treating the lock as unobtainable and refreshing anyway. A
// refresh we skip is a turn that fails, so the wait is bounded and the fallback is to proceed.
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 100;

const base64url = (buffer: Buffer): string => buffer.toString("base64url");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface AuthorizeChallenge {
    readonly authorizeUrl: string;
    readonly verifier: string;
    readonly state: string;
}

// Build the authorize URL plus the PKCE verifier/state the caller round-trips back to `exchangeCode`. The
// verifier is the client-held PKCE secret; handing it to the browser is expected for a public client and
// means no server-side pending-auth store is needed.
export const buildAuthorizeUrl = (): AuthorizeChallenge => {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(32));
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return { authorizeUrl: url.toString(), verifier, state };
};

/* The freshly-minted token set from an exchange/refresh — tokens plus an epoch-ms expiry (JSON-friendly), and
 * WHO the grant belongs to. Anthropic answers the token endpoint with the account's email and the organization
 * it authorized, and that pair is the only thing that tells two connections of the same provider apart: without
 * it a second sign-in lands as a second row called "Claude", and the account list stops answering the one
 * question it exists to answer. Both are optional because they are the provider's to send, and a token set that
 * arrives without them must still be a usable credential — the user names that account by hand instead. */
const TokenSetSchema = z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
    email: z.string().optional(),
    organization: z.string().optional(),
});
export type TokenSet = z.infer<typeof TokenSetSchema>;

// The persisted account: a token set tagged with its account identity. Stored beside the workspace, outside
// the three repos so it is never committed — one file per account under the store dir. A schema rather than a
// bare interface because reads are PARSED, not trusted: the store dir also holds the catalog's models.json, so
// an unparsed read surfaces every stray .json as a blank account in the picker.
const StoredAccountSchema = TokenSetSchema.extend({
    id: z.string(),
    label: z.string(),
    connectedAt: z.number(), // epoch ms
    // Set when the refresh token itself is dead (Anthropic answered invalid_grant — revoked, or already
    // rotated out from under us). The credential is then unusable and only a reconnect fixes it, so it is
    // recorded rather than retried: replaying a dead refresh token is what revokes the family in the first
    // place. `revokedReason` is the sentence the account list shows the user.
    revokedAt: z.number().optional(),
    revokedReason: z.string().optional(),
});
export type StoredAccount = z.infer<typeof StoredAccountSchema>;

// The metadata view (no tokens) the account list surfaces. A revoked credential rides out as the same
// needsReauth/detail pair Codex already uses, so the picker and the Setup row light up unchanged. The identity
// rides ALONGSIDE the label rather than inside it, so a renamed account ("Work") can still show whose it is.
export const toAccount = (stored: StoredAccount): OauthAccount => ({
    id: stored.id,
    label: stored.label,
    connectedAt: stored.connectedAt,
    ...(stored.email !== undefined ? { email: stored.email } : {}),
    ...(stored.organization !== undefined ? { organization: stored.organization } : {}),
    ...(stored.scope !== undefined ? { scope: stored.scope } : {}),
    ...(stored.revokedAt !== undefined ? { needsReauth: true, detail: stored.revokedReason ?? "Signed out — reconnect to keep using it." } : {}),
});

// Anthropic's token endpoint answers with the identity the grant belongs to beside the tokens themselves.
// Everything but the access token is optional here because it is the provider's to send — see readIdentity.
interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    account?: { email_address?: string };
    organization?: { name?: string };
}

// A non-2xx from the token endpoint, carrying enough to tell "the refresh token is dead" (invalid_grant, which
// is terminal and must stop the retry) from a transient failure worth trying again on the next turn.
export class TokenRequestError extends Error {
    constructor(
        readonly status: number,
        readonly body: string,
    ) {
        super(`Claude token request failed (${status}). ${body}`.trim());
    }

    get invalidGrant(): boolean {
        return this.body.includes("invalid_grant");
    }
}

/* Who the grant belongs to, read defensively: these fields are undocumented (like the whole flow — see the
 * constants above), so a shape change must cost the account its NAME, never its credential. Absent keys stay
 * absent rather than becoming `undefined` values, because a refresh merges its result over the stored account:
 * a present-but-empty key would erase an identity we already knew, and a missing one leaves it standing. */
const readIdentity = (json: TokenResponse): Pick<TokenSet, "email" | "organization"> => ({
    ...(typeof json.account?.email_address === "string" && json.account.email_address !== "" ? { email: json.account.email_address } : {}),
    ...(typeof json.organization?.name === "string" && json.organization.name !== "" ? { organization: json.organization.name } : {}),
});

const requestTokens = async (body: Record<string, string>): Promise<TokenSet> => {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new TokenRequestError(response.status, await response.text().catch(() => ""));
    }
    const json = (await response.json()) as TokenResponse;
    return {
        accessToken: json.access_token,
        ...(json.refresh_token !== undefined ? { refreshToken: json.refresh_token } : {}),
        ...(typeof json.expires_in === "number" ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
        ...(json.scope !== undefined ? { scope: json.scope } : {}),
        // Read on REFRESH as well as on exchange (same endpoint, same envelope), which is what lets an account
        // connected before any of this existed learn who it is on its next rotation rather than staying anonymous.
        ...readIdentity(json),
    };
};

// Anthropic's manual flow shows the value as `code#state`; accept either that or a bare code. Returns the raw
// token set — the caller tags it with account identity (id/label) before store.write.
export const exchangeCode = (pastedCode: string, verifier: string, fallbackState: string): Promise<TokenSet> => {
    const [code = "", state = fallbackState] = pastedCode.trim().split("#");
    return requestTokens({
        grant_type: "authorization_code",
        code,
        state,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
    });
};

/* The name a row carries, in one rule used by both connecting and renaming: what the user typed, else who the
 * provider says this is, else the provider's own name. The middle term is the point — "Claude" is a true but
 * useless answer to "which account is this?", and it was the ONLY answer a second connection could get. The
 * blank case matters on rename too: clearing the field means "go back to the derived name", not "leave this row
 * nameless". */
const resolveLabel = (label: string, identity: Pick<TokenSet, "email">): string => label.trim() || identity.email || "Claude";

// Tag a freshly-exchanged token set with a new account identity for storage.
export const newAccount = (tokens: TokenSet, label: string): StoredAccount => ({
    id: randomUUID(),
    label: resolveLabel(label, tokens),
    connectedAt: Date.now(),
    ...tokens,
});

// Rename a stored account, blank meaning "back to the derived name". Returns the account to persist; the caller
// owns the write, because it also owns the "does this account still exist?" answer.
export const renameAccount = (stored: StoredAccount, label: string): StoredAccount => ({ ...stored, label: resolveLabel(label, stored) });

export type RefreshFn = (refreshToken: string) => Promise<TokenSet>;

const refreshTokens: RefreshFn = (refreshToken) => requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID });

// The credential store, injected so the daemon's tests need no filesystem. Keyed by account id — a sandbox can
// hold several Claude accounts side by side. `withRefreshLock` is part of the store rather than a free
// function because the exclusion has to span every process sharing the store's dir, which only the store knows.
export interface ClaudeStore {
    readonly read: (id: string) => Promise<StoredAccount | undefined>;
    readonly write: (account: StoredAccount) => Promise<void>;
    readonly clear: (id: string) => Promise<void>;
    readonly list: () => Promise<OauthAccount[]>;
    // Run `act` with no other holder — in this process or any other — touching that account's tokens.
    readonly withRefreshLock: <T>(id: string, act: () => Promise<T>) => Promise<T>;
    readonly logger: Logger;
}

// A JSON file store: one <id>.json per account under <workspace>/.intentic/claude/ (outside the three repos).
export const fileClaudeStore = (dir: string, logger: Logger): ClaudeStore => {
    const path = (id: string): string => join(dir, `${id}.json`);
    const lockPath = (id: string): string => join(dir, `${id}.refresh.lock`);
    const readStored = async (id: string): Promise<StoredAccount | undefined> => {
        try {
            const parsed = StoredAccountSchema.safeParse(JSON.parse(await readFile(path(id), "utf8")));
            return parsed.success ? parsed.data : undefined;
        } catch {
            return undefined;
        }
    };
    // Take the lock file, or say why we are proceeding without it. Exclusive create IS the lock: two processes
    // racing `wx` on one path, exactly one wins, no daemon or advisory-lock service needed.
    const acquire = async (id: string): Promise<boolean> => {
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
            try {
                const handle = await open(lockPath(id), "wx");
                await handle.writeFile(`${process.pid}\n`);
                await handle.close();
                return true;
            } catch {
                // Held. A holder that died mid-refresh leaves the file behind forever, so an old one is stolen
                // rather than waited on — the alternative is a credential that never refreshes again.
                const age = await stat(lockPath(id))
                    .then((info) => Date.now() - info.mtimeMs)
                    .catch(() => 0);
                if (age > LOCK_STALE_MS) {
                    logger.warn({ account: id, ageMs: age }, "claude refresh lock is stale — stealing it");
                    await rm(lockPath(id), { force: true });
                    continue;
                }
                if (Date.now() >= deadline) {
                    // Refusing to refresh means the turn fails outright, which is worse than the (now unlikely)
                    // race we are guarding. Proceed, loudly.
                    logger.error({ account: id }, "claude refresh lock not obtained within the wait — refreshing unlocked");
                    return false;
                }
                await delay(LOCK_POLL_MS);
            }
        }
    };
    return {
        logger,
        read: readStored,
        // Atomic: a reader (this daemon, another sandbox, the account list) must never observe a half-written
        // file. An unparsed truncated read used to degrade to "no such account", which reads to the user as a
        // credential that silently disconnected itself.
        write: async (account) => {
            await mkdir(dir, { recursive: true });
            const temp = `${path(account.id)}.${randomUUID()}.tmp`;
            await writeFile(temp, `${JSON.stringify(account, undefined, 2)}\n`);
            await rename(temp, path(account.id));
        },
        clear: async (id) => {
            await rm(path(id), { force: true });
            await rm(lockPath(id), { force: true });
        },
        list: async () => {
            const entries = await readdir(dir).catch(() => [] as string[]);
            const stored = await Promise.all(entries.filter((name) => name.endsWith(".json")).map((name) => readStored(name.slice(0, -5))));
            return stored
                .filter((account): account is StoredAccount => account !== undefined)
                .map(toAccount)
                .toSorted((a, b) => a.connectedAt - b.connectedAt);
        },
        withRefreshLock: async (id, act) => {
            await mkdir(dir, { recursive: true });
            const held = await acquire(id);
            try {
                return await act();
            } finally {
                if (held) {
                    await rm(lockPath(id), { force: true });
                }
            }
        },
    };
};

// In-flight refreshes by account id, so the N callers a turn burst produces queue on one promise instead of N
// file locks. The cross-process lock still stands behind this — it is the only thing that covers a SECOND
// daemon on a shared AGENT_AUTH_DIR — but in the common single-daemon case this is what actually collapses the
// stampede.
const inFlight = new Map<string, Promise<string | undefined>>();

const usable = (account: StoredAccount): boolean => account.expiresAt === undefined || account.expiresAt - Date.now() > REFRESH_AHEAD_MS;

/* Rotate the account's tokens, superseding `spent` — the access token the caller found unusable (aged out, or
 * rejected mid-turn). Under the lock, "did someone already replace `spent`?" is the whole decision: if the
 * stored access token has moved on, another holder rotated while we queued and their token is the one to use.
 * Refreshing again from here would present a refresh token that has already been redeemed, which is the replay
 * Anthropic answers by revoking every token in the family. */
const rotate = async (store: ClaudeStore, id: string, spent: string | undefined, refresh: RefreshFn): Promise<string | undefined> => {
    const running = inFlight.get(id);
    if (running !== undefined) {
        return running;
    }
    const attempt = store
        .withRefreshLock(id, async () => {
            const current = await store.read(id);
            if (current === undefined || current.revokedAt !== undefined) {
                return undefined;
            }
            if (current.accessToken !== spent) {
                store.logger.debug({ account: id }, "claude token already rotated by another holder — adopting it");
                return current.accessToken;
            }
            if (current.refreshToken === undefined) {
                return current.accessToken;
            }
            try {
                const refreshed = await refresh(current.refreshToken);
                const next: StoredAccount = { ...current, ...refreshed, refreshToken: refreshed.refreshToken ?? current.refreshToken };
                await store.write(next);
                store.logger.info({ account: id, expiresAt: next.expiresAt }, "claude token refreshed");
                return next.accessToken;
            } catch (error) {
                if (!(error instanceof TokenRequestError) || !error.invalidGrant) {
                    throw error;
                }
                // Terminal. Record it so nothing retries this token: a second presentation is precisely what
                // makes Anthropic revoke every sibling token, and the account list can now say so out loud.
                await store.write({
                    ...current,
                    revokedAt: Date.now(),
                    revokedReason: "Claude sign-in was revoked — reconnect to keep using this account.",
                });
                store.logger.warn({ account: id }, "claude refresh token rejected (invalid_grant) — marked revoked");
                return undefined;
            }
        })
        .finally(() => inFlight.delete(id));
    inFlight.set(id, attempt);
    return attempt;
};

// Return a usable access token for the account, refreshing + persisting first if it has expired (or is about
// to) and a refresh token is available. undefined when the account isn't connected, or when its credential is
// revoked and only a reconnect can fix it — callers then fall back to the container's ANTHROPIC_API_KEY /
// CLAUDE_CODE_OAUTH_TOKEN env (if any).
export const ensureFreshToken = async (store: ClaudeStore, id: string, refresh: RefreshFn = refreshTokens): Promise<string | undefined> => {
    const account = await store.read(id);
    if (account === undefined || account.revokedAt !== undefined) {
        return undefined;
    }
    if (usable(account) || account.refreshToken === undefined) {
        return account.accessToken;
    }
    return rotate(store, id, account.accessToken, refresh);
};

// Mint a REPLACEMENT for a token the API just rejected, whatever its recorded expiry claimed. This is the
// mid-turn recovery path (see getOAuthToken in agent.ts): a family-wide revocation kills tokens that still look
// valid by the clock, so freshness is not the question — being different from the one that was refused is.
// Returning the same token back tells the CLI there is no refresh to be had, which is the honest answer when
// the credential is genuinely dead.
export const replaceRejectedToken = (
    store: ClaudeStore,
    id: string,
    rejected: string,
    refresh: RefreshFn = refreshTokens,
): Promise<string | undefined> => rotate(store, id, rejected, refresh);

// Refresh every connected account BEFORE a turn needs it. Lazy refresh alone means the rotation lands in the
// middle of whatever burst of turns happens to cross the expiry window; doing it on a quiet timer means the
// token a turn picks up is almost always minutes-old, and the locking above is a backstop rather than the
// mechanism. Runs through the same locked path, so the timer and a turn can never both rotate.
export const startClaudeRefresh = (store: ClaudeStore, intervalMs = 5 * 60_000): (() => void) => {
    const tick = async (): Promise<void> => {
        for (const account of await store.list()) {
            if (account.needsReauth === true) {
                continue;
            }
            await ensureFreshToken(store, account.id).catch((error: unknown) =>
                store.logger.warn({ err: error, account: account.id }, "claude proactive refresh failed — the next turn retries"),
            );
        }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    // The daemon's other loops do the same: a background refresh must never hold the process open.
    timer.unref();
    void tick();
    return () => clearInterval(timer);
};
