import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OauthAccount } from "@intentic/sandbox-contract";

/* ChatGPT (Codex) OAuth against the public Codex CLI client — the sandbox-owned twin of claude-credentials.ts.
 * Uses the device-code flow (`codex login --device-auth`, openai/codex codex-rs/login/device_code_auth.rs): the
 * daemon requests a one-time user_code, the user opens auth.openai.com/codex/device and enters it, and the
 * daemon polls until sign-in completes — no localhost loopback listener (which the daemon, running remotely,
 * can't host) and no paste-back. The poll returns an authorization_code + server-issued PKCE verifier, which we
 * exchange at /oauth/token for the tokens. The constants mirror what `codex login` uses and may change.
 *
 * Tokens are stored in Codex's own auth.json format under a workspace-scoped CODEX_HOME — the Codex CLI
 * refreshes them in place during turns. We add an offline-gated probe (probeCodexHealth) that, only for an idle
 * account whose access token has expired, attempts the same refresh the CLI would do (persisting it atomically)
 * so a revoked refresh token surfaces as `needsReauth` BEFORE the user chats — instead of an opaque CLI failure
 * mid-turn. An in-use account keeps its access token fresh via the CLI, so the offline gate means we never race
 * the CLI's refresh on it (see probeCodexHealth).
 * ponytail: the /deviceauth/* protocol is proprietary and pinned to current Codex behavior; if OpenAI changes
 * it, spawn the already-vendored `codex login --device-auth` binary instead of reimplementing the calls. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const API_BASE = `${ISSUER}/api/accounts`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const VERIFICATION_URI = `${ISSUER}/codex/device`;
// The device-code grant is bound to this redirect (codex-rs `{base_url}/deviceauth/callback`), not the 1455
// loopback — the /oauth/token exchange returns invalid_grant if they don't match.
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
// Probe refreshes a little before the real access-token expiry so an idle account is caught just ahead of the
// deadline (mirrors Claude's EXPIRY_SKEW_MS).
const EXPIRY_SKEW_MS = 60_000;

export interface DeviceChallenge {
    readonly userCode: string;
    readonly deviceAuthId: string;
    readonly interval: number;
    readonly verificationUri: string;
}

// OpenAI sends `interval` as a string (codex-rs string-parses it) and the code under either `user_code` or
// `usercode` (a serde alias) — normalize both so the number-typed contract output validates.
interface UserCodeResponse {
    device_auth_id: string;
    user_code?: string;
    usercode?: string;
    interval?: string;
}

// Step 1: request a one-time device code. The caller shows userCode + verificationUri to the user, then polls
// pollDeviceAuth(deviceAuthId, userCode) on `interval` until the sign-in completes.
export const startDeviceAuth = async (): Promise<DeviceChallenge> => {
    const response = await fetch(`${API_BASE}/deviceauth/usercode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`ChatGPT device-code request failed (${response.status}). ${detail}`.trim());
    }
    const json = (await response.json()) as UserCodeResponse;
    return {
        userCode: json.user_code ?? json.usercode ?? "",
        deviceAuthId: json.device_auth_id,
        interval: Number(json.interval) || 5,
        verificationUri: VERIFICATION_URI,
    };
};

interface DeviceTokenResponse {
    authorization_code: string;
    code_verifier: string;
}

// Step 2: poll the device-auth token endpoint. 403/404 = the user hasn't finished signing in yet (undefined,
// so the caller keeps polling); a 200 carries the authorization_code + server-issued PKCE verifier, which we
// immediately exchange at /oauth/token for the real tokens.
export const pollDeviceAuth = async (deviceAuthId: string, userCode: string): Promise<CodexTokens | undefined> => {
    const poll = await fetch(`${API_BASE}/deviceauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
    if (poll.status === 403 || poll.status === 404) {
        return undefined;
    }
    if (!poll.ok) {
        const detail = await poll.text().catch(() => "");
        throw new Error(`ChatGPT device-code poll failed (${poll.status}). ${detail}`.trim());
    }
    const { authorization_code, code_verifier } = (await poll.json()) as DeviceTokenResponse;
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: authorization_code,
            redirect_uri: DEVICE_REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier,
        }),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`ChatGPT token request failed (${response.status}). ${detail}`.trim());
    }
    const json = (await response.json()) as TokenResponse;
    const accountId = accountIdOf(json.id_token);
    return {
        idToken: json.id_token,
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        ...(accountId !== undefined ? { accountId } : {}),
    };
};

// The token set written into Codex's native auth.json.
export interface CodexTokens {
    readonly idToken: string;
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly accountId?: string;
}

interface TokenResponse {
    id_token: string;
    access_token: string;
    refresh_token: string;
}

// Decode a JWT's payload without verification (we only relay tokens into auth.json / derive a label / read the
// access token's expiry; the API is the verifier).
const jwtClaims = (token: string): Record<string, unknown> | undefined => {
    const payload = token.split(".")[1];
    if (payload === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
        return undefined;
    }
};

// The ChatGPT account id lives in the id_token's `https://api.openai.com/auth` claim (chatgpt_account_id).
const accountIdOf = (idToken: string): string | undefined => {
    const auth = jwtClaims(idToken)?.["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
};

// The signed-in email, for auto-labeling the account when the user gives no label.
export const emailOf = (idToken: string): string | undefined => {
    const email = jwtClaims(idToken)?.["email"];
    return typeof email === "string" ? email : undefined;
};

// The access token's expiry (epoch ms) from its `exp` claim — the offline gate for the health probe. undefined
// when the token isn't a decodable JWT with a numeric exp (then the probe stays fail-open, never nags).
const accessTokenExpMs = (accessToken: string): number | undefined => {
    const exp = jwtClaims(accessToken)?.["exp"];
    return typeof exp === "number" ? exp * 1000 : undefined;
};

// The proactive health verdict for one account: present only when the credential can't be refreshed and the
// user must reconnect. undefined ⇒ healthy or unknown (we fail open — a transient blip never nags).
export interface CodexReauthNeeded {
    readonly needsReauth: true;
    readonly detail: string;
}

// A refresh response — access token always, the rest only when the endpoint returns them (a refresh may omit
// a new id_token / refresh_token; the caller preserves the prior ones).
interface RefreshedTokens {
    readonly accessToken: string;
    readonly idToken?: string;
    readonly refreshToken?: string;
    readonly accountId?: string;
}
export type CodexRefreshFn = (refreshToken: string) => Promise<RefreshedTokens>;

// Carries the HTTP status so the probe can tell a revoked/expired grant (4xx) from a transient blip (5xx /
// network) — the former is needsReauth, the latter fails open.
class CodexRefreshError extends Error {
    constructor(
        readonly status: number,
        detail: string,
    ) {
        super(`ChatGPT token refresh failed (${status}). ${detail}`.trim());
    }
}

// Exchange the refresh token for a fresh access token at the same /oauth/token endpoint the device-code flow
// uses (urlencoded, matching pollDeviceAuth's working call).
const refreshCodexTokens: CodexRefreshFn = async (refreshToken) => {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID, scope: "openid profile email" }),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new CodexRefreshError(response.status, detail);
    }
    const json = (await response.json()) as { access_token: string; id_token?: string; refresh_token?: string };
    const accountId = json.id_token !== undefined ? accountIdOf(json.id_token) : undefined;
    return {
        accessToken: json.access_token,
        ...(json.id_token !== undefined ? { idToken: json.id_token } : {}),
        ...(json.refresh_token !== undefined ? { refreshToken: json.refresh_token } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
    };
};

// Identity sidecar beside Codex's own auth.json (which the CLI owns), holding what the account list needs.
interface CodexMeta {
    readonly id: string;
    readonly label: string;
    readonly connectedAt: number; // epoch ms
}

// The credential store, injected so the daemon's tests need no filesystem. Keyed by account id — each account
// is its own CODEX_HOME dir (`<baseDir>/<id>`) holding Codex's native auth.json plus a meta.json sidecar. The
// daemon never reads the tokens back (the Codex CLI owns refresh), so `connected` is an existence check.
export interface CodexStore {
    // The per-account CODEX_HOME the agent env points at.
    readonly home: (id: string) => string;
    readonly connected: (id: string) => Promise<boolean>;
    // Read the stored token set (for the health probe); undefined when the account has no usable auth.json.
    readonly read: (id: string) => Promise<CodexTokens | undefined>;
    readonly write: (id: string, label: string, tokens: CodexTokens) => Promise<void>;
    // Rewrite ONLY auth.json (no meta) atomically — the probe persists a refreshed token set without a label.
    readonly writeTokens: (id: string, tokens: CodexTokens) => Promise<void>;
    readonly clear: (id: string) => Promise<void>;
    readonly list: () => Promise<OauthAccount[]>;
}

// Privacy-hardened Codex config for a CODEX_HOME: Codex has no telemetry env vars — analytics (chatgpt.com
// events, whose flag also gates the default statsig metrics exporter), the Sentry-backed /feedback flow, and
// the startup update probe (the CLI is image-pinned) are all config.toml keys, at the user level $CODEX_HOME.
const CODEX_CONFIG = `check_for_update_on_startup = false

[analytics]
enabled = false

[feedback]
enabled = false

[otel]
metrics_exporter = "none"
`;

// Ensure a CODEX_HOME exists with the hardened config.toml. Never overwrites ("wx") — the file is Codex's
// user-level config, which the agent may legitimately extend later (e.g. mcp_servers).
export const writeCodexConfig = async (home: string): Promise<void> => {
    await mkdir(home, { recursive: true });
    try {
        await writeFile(join(home, "config.toml"), CODEX_CONFIG, { flag: "wx" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
    }
};

// Writes Codex's native auth.json under `<baseDir>/<id>` — the exact shape `codex login` produces, so the CLI
// treats it as its own and refreshes it in place. OPENAI_API_KEY is explicitly null in that wire format.
export const fileCodexStore = (baseDir: string): CodexStore => {
    const home = (id: string): string => join(baseDir, id);
    const authPath = (id: string): string => join(home(id), "auth.json");
    const metaPath = (id: string): string => join(home(id), "meta.json");
    const hasToken = async (id: string): Promise<boolean> => {
        try {
            const auth = JSON.parse(await readFile(authPath(id), "utf8")) as { tokens?: { access_token?: string } };
            return typeof auth.tokens?.access_token === "string";
        } catch {
            return false;
        }
    };
    const readTokens = async (id: string): Promise<CodexTokens | undefined> => {
        try {
            const auth = JSON.parse(await readFile(authPath(id), "utf8")) as {
                tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string };
            };
            const t = auth.tokens;
            if (t?.id_token === undefined || t.access_token === undefined || t.refresh_token === undefined) {
                return undefined;
            }
            return {
                idToken: t.id_token,
                accessToken: t.access_token,
                refreshToken: t.refresh_token,
                ...(t.account_id !== undefined ? { accountId: t.account_id } : {}),
            };
        } catch {
            return undefined;
        }
    };
    // Write auth.json in the exact `codex login` wire shape (the one place the format is defined). Atomic —
    // the Codex CLI may read it concurrently — via temp file + rename.
    const writeTokens = async (id: string, tokens: CodexTokens): Promise<void> => {
        await writeCodexConfig(home(id));
        const auth = {
            OPENAI_API_KEY: null,
            tokens: {
                id_token: tokens.idToken,
                access_token: tokens.accessToken,
                refresh_token: tokens.refreshToken,
                ...(tokens.accountId !== undefined ? { account_id: tokens.accountId } : {}),
            },
            last_refresh: new Date().toISOString(),
        };
        const tmp = `${authPath(id)}.${randomUUID()}.tmp`;
        await writeFile(tmp, `${JSON.stringify(auth, undefined, 2)}\n`);
        await rename(tmp, authPath(id));
    };
    return {
        home,
        connected: hasToken,
        read: readTokens,
        writeTokens,
        write: async (id, label, tokens) => {
            await writeTokens(id, tokens);
            const meta: CodexMeta = { id, label: label.trim() !== "" ? label.trim() : "ChatGPT", connectedAt: Date.now() };
            await writeFile(metaPath(id), `${JSON.stringify(meta, undefined, 2)}\n`);
        },
        clear: (id) => rm(home(id), { recursive: true, force: true }),
        list: async () => {
            const ids = await readdir(baseDir).catch(() => [] as string[]);
            const accounts = await Promise.all(
                ids.map(async (id): Promise<OauthAccount | undefined> => {
                    if (!(await hasToken(id))) {
                        return undefined;
                    }
                    try {
                        const meta = JSON.parse(await readFile(metaPath(id), "utf8")) as CodexMeta;
                        return { id: meta.id, label: meta.label, connectedAt: meta.connectedAt };
                    } catch {
                        return { id, label: "ChatGPT", connectedAt: 0 };
                    }
                }),
            );
            return accounts.filter((account): account is OauthAccount => account !== undefined).toSorted((a, b) => a.connectedAt - b.connectedAt);
        },
    };
};

// Proactive health check for one Codex account, the sandbox-owned twin of Claude's ensureFreshToken. Offline-
// gated: while the access token is still valid we return healthy WITHOUT any network — and without touching the
// refresh token the Codex CLI may be using — so an in-use account (whose CLI keeps the access token fresh each
// turn) is never refreshed here; only an idle account with an expired access token is probed. On an expired
// token we attempt the refresh the CLI would do anyway and persist it atomically, so success keeps the account
// alive; a 4xx means the refresh token is revoked/expired ⇒ needsReauth. Transient/network errors fail open.
export const probeCodexHealth = async (
    store: CodexStore,
    id: string,
    refresh: CodexRefreshFn = refreshCodexTokens,
): Promise<CodexReauthNeeded | undefined> => {
    const tokens = await store.read(id);
    if (tokens === undefined) {
        return undefined;
    }
    const expMs = accessTokenExpMs(tokens.accessToken);
    if (expMs === undefined || expMs - Date.now() > EXPIRY_SKEW_MS) {
        return undefined;
    }
    try {
        const fresh = await refresh(tokens.refreshToken);
        const accountId = fresh.accountId ?? tokens.accountId;
        await store.writeTokens(id, {
            idToken: fresh.idToken ?? tokens.idToken,
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken ?? tokens.refreshToken,
            ...(accountId !== undefined ? { accountId } : {}),
        });
        return undefined;
    } catch (error) {
        if (error instanceof CodexRefreshError && error.status >= 400 && error.status < 500) {
            // Rotation race: the Codex CLI may have refreshed first, invalidating the token we just tried. If
            // the stored refresh token has changed, this isn't a revocation — stay healthy.
            const current = await store.read(id);
            if (current !== undefined && current.refreshToken !== tokens.refreshToken) {
                return undefined;
            }
            return { needsReauth: true, detail: "Your ChatGPT sign-in was revoked or expired. Reconnect the account to keep using it." };
        }
        return undefined;
    }
};
