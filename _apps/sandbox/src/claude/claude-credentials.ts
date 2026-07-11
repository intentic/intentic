import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OauthAccount } from "@intentic/sandbox-contract";

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

// Refresh a little before the real expiry so an in-flight turn doesn't race the deadline.
const EXPIRY_SKEW_MS = 60_000;

const base64url = (buffer: Buffer): string => buffer.toString("base64url");

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

// The freshly-minted token set from an exchange/refresh — tokens plus an epoch-ms expiry (JSON-friendly),
// before it is tagged with account identity.
export interface TokenSet {
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly expiresAt?: number;
    readonly scope?: string;
}

// The persisted account: a token set tagged with its account identity. Stored beside the workspace, outside
// the three repos so it is never committed — one file per account under the store dir.
export interface StoredAccount extends TokenSet {
    readonly id: string;
    readonly label: string;
    readonly connectedAt: number; // epoch ms
}

// The metadata view (no tokens) the account list surfaces.
const toAccount = (stored: StoredAccount): OauthAccount => ({
    id: stored.id,
    label: stored.label,
    connectedAt: stored.connectedAt,
    ...(stored.scope !== undefined ? { scope: stored.scope } : {}),
});

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
}

const requestTokens = async (body: Record<string, string>): Promise<TokenSet> => {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Claude token request failed (${response.status}). ${detail}`.trim());
    }
    const json = (await response.json()) as TokenResponse;
    return {
        accessToken: json.access_token,
        ...(json.refresh_token !== undefined ? { refreshToken: json.refresh_token } : {}),
        ...(typeof json.expires_in === "number" ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
        ...(json.scope !== undefined ? { scope: json.scope } : {}),
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

// Tag a freshly-exchanged token set with a new account identity for storage.
export const newAccount = (tokens: TokenSet, label: string): StoredAccount => ({
    id: randomUUID(),
    label: label.trim() !== "" ? label.trim() : "Claude",
    connectedAt: Date.now(),
    ...tokens,
});

export type RefreshFn = (refreshToken: string) => Promise<TokenSet>;

const refreshTokens: RefreshFn = (refreshToken) => requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID });

// The credential store, injected so the daemon's tests need no filesystem. Keyed by account id — a sandbox can
// hold several Claude accounts side by side.
export interface ClaudeStore {
    readonly read: (id: string) => Promise<StoredAccount | undefined>;
    readonly write: (account: StoredAccount) => Promise<void>;
    readonly clear: (id: string) => Promise<void>;
    readonly list: () => Promise<OauthAccount[]>;
}

// A JSON file store: one <id>.json per account under <workspace>/.intentic/claude/ (outside the three repos).
export const fileClaudeStore = (dir: string): ClaudeStore => {
    const path = (id: string): string => join(dir, `${id}.json`);
    const readStored = async (id: string): Promise<StoredAccount | undefined> => {
        try {
            return JSON.parse(await readFile(path(id), "utf8")) as StoredAccount;
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
                .filter((account): account is StoredAccount => account !== undefined)
                .map(toAccount)
                .toSorted((a, b) => a.connectedAt - b.connectedAt);
        },
    };
};

// Return a usable access token for the account, refreshing + persisting first if it has expired (or is about
// to) and a refresh token is available. undefined when the account isn't connected — callers then fall back to
// the container's ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN env (if any).
export const ensureFreshToken = async (store: ClaudeStore, id: string, refresh: RefreshFn = refreshTokens): Promise<string | undefined> => {
    const account = await store.read(id);
    if (account === undefined) {
        return undefined;
    }
    const stillValid = account.expiresAt === undefined || account.expiresAt - Date.now() > EXPIRY_SKEW_MS;
    if (stillValid || account.refreshToken === undefined) {
        return account.accessToken;
    }
    const refreshed = await refresh(account.refreshToken);
    const next: StoredAccount = { ...account, ...refreshed, refreshToken: refreshed.refreshToken ?? account.refreshToken };
    await store.write(next);
    return next.accessToken;
};
