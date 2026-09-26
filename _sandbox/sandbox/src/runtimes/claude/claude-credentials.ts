import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SingleFlight, sleep } from "@intentic/base/async";
import type { OauthAccount } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { accountFiles } from "../../agent/providers/accounts/account-files.js";

// Claude subscription OAuth (PKCE) against the public Claude Code client; the sandbox owns these credentials, not the
// platform. The constants mirror claude setup-token and are unofficial. Anthropic's redirect page returns code#state;
// the caller pastes it back to exchangeCode.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";
// Who the sandbox says it is when it asks Anthropic directly as Claude Code does: the limit-reset reads
// (usage/claude-limit-reset.ts) and the seat probe (claude-seat-check.ts).
export const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.257 (external, cli)";

// A replayed refresh token revokes the whole family; a refresh runs at most once per rotation.

// How far ahead of expiry to refresh; a turn's token is snapshotted into its subprocess env and can't be renewed.
const REFRESH_AHEAD_MS = 30 * 60_000;

// Age at which rotation proceeds despite held turns; waiting longer risks failing the next turn too.
const ROTATE_REGARDLESS_MS = 2 * 60_000;

// How early rotation starts hunting a quiet gap; release-triggered, since a timer alone misses short gaps.
const OPPORTUNISTIC_AHEAD_MS = 4 * 60 * 60_000;

// Count of turns holding each account's token; only whether rotating would break one matters, not which turns.
const holders = new Map<string, number>();

// Set by startClaudeRefresh; module-scoped since only the release closure, not each turn, learns of a gap.
let releaseQuiet: ((id: string) => void) | undefined;

// Claims the account for a turn's lifetime; the release must run in that turn's finally. Called only for a turn on a
// stored credential, the container-env fallback has no rotation to defer.
export const holdAccount = (id: string): (() => void) => {
    holders.set(id, (holders.get(id) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        const remaining = (holders.get(id) ?? 1) - 1;
        if (remaining > 0) {
            holders.set(id, remaining);
            return;
        }
        holders.delete(id);
        // Fires the rotation now, not on the next timer tick, since inter-turn gaps are often shorter than it.
        releaseQuiet?.(id);
    };
};

// Whether to postpone rotation: someone holds the token, and it has enough life left that waiting is safe.
const deferrable = (account: StoredAccount, now: number): boolean =>
    (holders.get(account.id) ?? 0) > 0 && account.expiresAt !== undefined && account.expiresAt - now > ROTATE_REGARDLESS_MS;

// A refresh is one HTTPS round-trip; a lock older than this belongs to a process that died holding it.
const LOCK_STALE_MS = 30_000;
// How long to wait for the lock before refreshing unlocked; skipping the refresh would fail the turn instead.
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 100;

const base64url = (buffer: Buffer): string => buffer.toString("base64url");

export interface AuthorizeChallenge {
    readonly authorizeUrl: string;
    readonly verifier: string;
    readonly state: string;
}

// Builds the authorize URL plus the PKCE verifier/state round-tripped to exchangeCode. The verifier travels to the
// browser, which is normal for a public client and needs no server-side pending-auth store.
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

// Token set from an exchange/refresh: tokens, an epoch-ms expiry, and the identity that tells two connections of the
// same provider apart. Both identity fields are optional; without them the user names the account by hand.
const TokenSetSchema = z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
    email: z.string().optional(),
    organization: z.string().optional(),
});
export type TokenSet = z.infer<typeof TokenSetSchema>;

// Persisted account: a token set plus identity, one file per account under the store dir. A schema, not a bare
// interface: the dir also holds the catalog's models.json, and reads are parsed, not trusted.
const StoredAccountSchema = TokenSetSchema.extend({
    id: z.string(),
    // Only a name the user typed; absent means the display name is derived at read time, not frozen here.
    label: z.string().optional(),
    connectedAt: z.number(), // epoch ms
    // Set when the refresh token is dead (invalid_grant); only a reconnect fixes it. Shown via revokedReason.
    revokedAt: z.number().optional(),
    revokedReason: z.string().optional(),
});
export type StoredAccount = z.infer<typeof StoredAccountSchema>;

// Row name: typed label, else the provider identity, else 'Claude'. Derived on every read, never stored, so a later
// refresh renames the row on its own.
export const displayLabel = (stored: Pick<StoredAccount, "label" | "email">): string => stored.label?.trim() || stored.email || "Claude";

// Metadata view (no tokens) for the account list. A revoked credential surfaces as needsReauth/detail, the same pair
// Codex uses; identity travels alongside the label so a rename still shows whose account it is.
export const toAccount = (stored: StoredAccount): OauthAccount => ({
    id: stored.id,
    label: displayLabel(stored),
    connectedAt: stored.connectedAt,
    ...(stored.email !== undefined ? { email: stored.email } : {}),
    ...(stored.organization !== undefined ? { organization: stored.organization } : {}),
    ...(stored.scope !== undefined ? { scope: stored.scope } : {}),
    ...(stored.revokedAt !== undefined ? { needsReauth: true, detail: stored.revokedReason ?? "Signed out, reconnect to keep using it." } : {}),
});

// Token-endpoint response shape; everything but access_token is optional since it's the provider's to send (see
// readIdentity).
interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    account?: { email_address?: string };
    organization?: { name?: string };
}

// A non-2xx from the token endpoint; invalidGrant distinguishes a dead refresh token (stop retrying) from a transient
// failure.
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

// Identity fields are undocumented, so a shape change may cost the name, never the credential. Keys are omitted rather
// than set to undefined, since an empty key would erase an identity a refresh already knew.
const readIdentity = (json: TokenResponse): Pick<TokenSet, "email" | "organization"> => ({
    ...(typeof json.account?.email_address === "string" && json.account.email_address !== "" ? { email: json.account.email_address } : {}),
    ...(typeof json.organization?.name === "string" && json.organization.name !== "" ? { organization: json.organization.name } : {}),
});

// Timeout for the token endpoint; fetch has no timeout of its own, and callers here must never hang.
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

const requestTokens = async (body: Record<string, string>): Promise<TokenSet> => {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // A timeout throws TimeoutError, not TokenRequestError, so it reads as transient, never as invalid_grant.
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
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
        // Read on refresh too, same endpoint/envelope, so an account with no identity learns it on its next rotation.
        ...readIdentity(json),
    };
};

// Accepts Anthropic's pasted `code#state` or a bare code. Returns the raw token set; the caller tags it with an account
// identity before store.write.
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

// Tags a freshly-exchanged token set with a new account id. A blank label is stored as no label, so the row reads as
// the provider identity instead.
export const newAccount = (tokens: TokenSet, label: string): StoredAccount => ({
    id: randomUUID(),
    ...(label.trim() !== "" ? { label: label.trim() } : {}),
    connectedAt: Date.now(),
    ...tokens,
});

// A sign-in for an identity already on file (account-identity.ts `sameAccount`) lands on that account: same id, and the
// revoke mark goes with the dead tokens. A label typed now renames it; none keeps the old name.
export const reconnectAccount = (stored: StoredAccount, tokens: TokenSet, label: string): StoredAccount => {
    const { revokedAt: _revokedAt, revokedReason: _revokedReason, accessToken: _a, refreshToken: _r, expiresAt: _e, scope: _s, ...kept } = stored;
    return { ...kept, ...tokens, ...(label.trim() !== "" ? { label: label.trim() } : {}) };
};

// Renames a stored account; a blank label drops the key rather than freezing the derived name, so the row keeps
// following the identity. Caller owns the write.
export const renameAccount = (stored: StoredAccount, label: string): StoredAccount => {
    const { label: _previous, ...rest } = stored;
    return { ...rest, ...(label.trim() !== "" ? { label: label.trim() } : {}) };
};

export type RefreshFn = (refreshToken: string) => Promise<TokenSet>;

const refreshTokens: RefreshFn = (refreshToken) => requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID });

// Credential store, injected so tests need no filesystem; keyed by account id. withRefreshLock lives here since only
// the store knows which processes share its dir.
export interface ClaudeStore {
    readonly read: (id: string) => Promise<StoredAccount | undefined>;
    readonly write: (account: StoredAccount) => Promise<void>;
    readonly clear: (id: string) => Promise<void>;
    readonly list: () => Promise<OauthAccount[]>;
    // Runs act with no other holder, in this process or any other, touching that account's tokens.
    readonly withRefreshLock: <T>(id: string, act: () => Promise<T>) => Promise<T>;
    readonly logger: Logger;
}

// A JSON file store: one <id>.json per account under <workspace>/.intentic/secrets/auth/claude/ (outside the three repos).
export const fileClaudeStore = (dir: string, logger: Logger): ClaudeStore => {
    // The catalog's models.json shares this directory, and reads as no account.
    const files = accountFiles(dir, StoredAccountSchema);
    const lockPath = (id: string): string => join(dir, `${id}.refresh.lock`);
    // Takes the lock file, or explains why it proceeds without it. Exclusive create is the lock: two processes racing
    // `wx` on one path, exactly one wins.
    const acquire = async (id: string): Promise<boolean> => {
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
            try {
                const handle = await open(lockPath(id), "wx");
                await handle.writeFile(`${process.pid}\n`);
                await handle.close();
                return true;
            } catch {
                // A holder that died mid-refresh leaves the lock behind forever; a stale one is stolen rather than
                // waited on.
                const age = await stat(lockPath(id))
                    .then((info) => Date.now() - info.mtimeMs)
                    .catch(() => 0);
                if (age > LOCK_STALE_MS) {
                    logger.warn({ account: id, ageMs: age }, "claude refresh lock is stale, stealing it");
                    await rm(lockPath(id), { force: true });
                    continue;
                }
                if (Date.now() >= deadline) {
                    // Refusing to refresh fails the turn outright, worse than the race being guarded against; proceed,
                    // loudly.
                    logger.error({ account: id }, "claude refresh lock not obtained within the wait, refreshing unlocked");
                    return false;
                }
                await sleep(LOCK_POLL_MS);
            }
        }
    };
    return {
        logger,
        read: files.read,
        write: files.write,
        clear: async (id) => {
            await files.remove(id);
            await rm(lockPath(id), { force: true });
        },
        list: async () => (await files.list()).map(toAccount),
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

// In-flight refreshes by account id, so a turn burst's callers share one promise instead of N file-lock waits.
const refreshes = new SingleFlight<string, string | undefined>();

const usable = (account: StoredAccount): boolean => account.expiresAt === undefined || account.expiresAt - Date.now() > REFRESH_AHEAD_MS;

// Rotates the account's tokens, superseding `spent`. Under the lock, if the stored token already moved on, adopts it
// instead of refreshing again, since refreshing would replay an already-redeemed refresh token.
const rotate = async (store: ClaudeStore, id: string, spent: string | undefined, refresh: RefreshFn): Promise<string | undefined> =>
    refreshes.run(id, () =>
        store.withRefreshLock(id, async () => {
            const current = await store.read(id);
            if (current === undefined || current.revokedAt !== undefined) {
                return undefined;
            }
            if (current.accessToken !== spent) {
                store.logger.debug({ account: id }, "claude token already rotated by another holder, adopting it");
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
                // Terminal: recorded so nothing retries this token, since replaying it revokes every sibling token too.
                await store.write({
                    ...current,
                    revokedAt: Date.now(),
                    revokedReason: "Claude sign-in was revoked, reconnect to keep using this account.",
                });
                store.logger.warn({ account: id }, "claude refresh token rejected (invalid_grant), marked revoked");
                return undefined;
            }
        }),
    );

// Returns a usable access token, refreshing and persisting first if expired or close to it. undefined when unconnected
// or revoked; callers then fall back to the container's ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN env.
export const ensureFreshToken = async (store: ClaudeStore, id: string, refresh: RefreshFn = refreshTokens): Promise<string | undefined> => {
    // Waits for any in-flight rotation first, so a new turn never snapshots the token that rotation is superseding.
    await refreshes.joined(id)?.catch(() => undefined);
    const account = await store.read(id);
    if (account === undefined || account.revokedAt !== undefined) {
        return undefined;
    }
    if (usable(account) || account.refreshToken === undefined) {
        return account.accessToken;
    }
    // Live turns hold this exact token (ROTATE_REGARDLESS_MS); a starting turn resolves through this same path too.
    if (deferrable(account, Date.now())) {
        store.logger.debug({ account: id }, "claude token rotation deferred, turns are holding it");
        return account.accessToken;
    }
    // Past the floor with turns holding it: they 401 and are resumed; logged so the collision is visible.
    const breaking = holders.get(id) ?? 0;
    if (breaking > 0) {
        store.logger.warn(
            { account: id, turns: breaking, expiresAt: account.expiresAt },
            "claude token rotating with turns still holding it: they will be refused and resumed",
        );
    }
    return rotate(store, id, account.accessToken, refresh);
};

// Mints a replacement for a token the API just rejected, regardless of its recorded expiry (the mid-turn recovery path,
// see getOAuthToken in agent.ts). Returning the same token back tells the CLI the credential is genuinely dead.
export const replaceRejectedToken = (
    store: ClaudeStore,
    id: string,
    rejected: string,
    refresh: RefreshFn = refreshTokens,
): Promise<string | undefined> => rotate(store, id, rejected, refresh);

// Rotates when nobody holds the token and it is within OPPORTUNISTIC_AHEAD_MS of expiry. Failure is logged and left;
// the token is still valid for hours, and the next gap tries again.
const rotateWhileQuiet = async (store: ClaudeStore, id: string, refresh: RefreshFn): Promise<void> => {
    if ((holders.get(id) ?? 0) > 0) {
        return;
    }
    const account = await store.read(id);
    if (account === undefined || account.revokedAt !== undefined || account.refreshToken === undefined) {
        return;
    }
    if (account.expiresAt === undefined || account.expiresAt - Date.now() > OPPORTUNISTIC_AHEAD_MS) {
        return;
    }
    await rotate(store, id, account.accessToken, refresh).catch((error: unknown) =>
        store.logger.warn({ err: error, account: id }, "claude quiet-moment refresh failed, the next gap retries"),
    );
};

// Refreshes every connected account before a turn needs it, via each turn's release (catches short gaps) plus a slow
// timer backstop that also runs the lazy path for a token nearing REFRESH_AHEAD_MS.
export const startClaudeRefresh = (store: ClaudeStore, intervalMs = 5 * 60_000, refresh: RefreshFn = refreshTokens): (() => void) => {
    const quietly = (id: string): Promise<void> =>
        rotateWhileQuiet(store, id, refresh).catch((error: unknown) =>
            store.logger.warn({ err: error, account: id }, "claude quiet-moment refresh could not read the account, the next gap retries"),
        );
    const tick = async (): Promise<void> => {
        let accounts: readonly OauthAccount[];
        try {
            accounts = await store.list();
        } catch (error) {
            store.logger.warn({ err: error }, "claude proactive refresh: the accounts could not be listed, the next tick retries");
            return;
        }
        for (const account of accounts) {
            if (account.needsReauth === true) {
                continue;
            }
            await quietly(account.id);
            await ensureFreshToken(store, account.id, refresh).catch((error: unknown) =>
                store.logger.warn({ err: error, account: account.id }, "claude proactive refresh failed, the next turn retries"),
            );
        }
    };
    // Fire-and-forget: a turn's finally must not wait on an HTTPS round-trip for a result it wouldn't use.
    releaseQuiet = (id) => void quietly(id);
    const timer = setInterval(() => void tick(), intervalMs);
    // A background refresh must never hold the process open.
    timer.unref();
    void tick();
    return () => {
        releaseQuiet = undefined;
        clearInterval(timer);
    };
};
