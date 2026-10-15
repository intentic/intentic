import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sleep } from "@intentic/base/async";
import { type AgentStoreOptions, storeRefreshTokenAsAgent } from "@intentic/connector-runtime";
import { extensionStateDir } from "@intentic/sandbox-contract/workspace-state";
import { type Account, bindingOf, cloudOf, DEFAULT_AUTHORITY, scopesFor } from "./accounts.js";

// Sign-in and token upkeep for one card. The refresh token lives only on the card (the daemon's vault) and in this
// process's memory: a sign-in or a rotation is written back through the daemon's oauth-token route, never printed and
// never put in a file. What is cached on disk is the one-hour access token, as google-workspace's `gw` does, so a run of
// commands does not mint (and rotate) on every call.

export type Http = (url: string, init?: RequestInit) => Promise<Response>;
// Stores a new refresh token on the card. `previous` is the token this process held: the daemon refuses a write from
// anyone who does not hold the current one.
export type SaveToken = (token: string, previous: string, login?: boolean) => Promise<void>;

interface TokenAnswer {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
}

const tokenUrl = (account: Account): string => `https://${cloudOf(account).authority}/${encodeURIComponent(account.tenantId)}/oauth2/v2.0/token`;

// An authority's error body may echo a credential: only its protocol error code and the status leave this module.
const formCall = async <T>(http: Http, url: string, form: Record<string, string> | URLSearchParams): Promise<T & { error?: string }> => {
    const response = await http(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
    });
    let answer: T & { error?: string };
    try {
        // SAFETY: every field of a token or device answer is optional in its type and checked before it is used.
        answer = (await response.json()) as T & { error?: string };
    } catch {
        throw new Error("Microsoft sign-in returned an unreadable answer");
    }
    if (!response.ok && !answer.error) {
        throw new Error(`Microsoft sign-in failed (${response.status})`);
    }
    return answer;
};

// Microsoft refused the sign-in itself: nothing but a new sign-in (or a fixed card) helps, so a watcher stops on it.
export class SignInError extends Error {}

// What each refusal means for the card, said as what the office does about it.
const refusal = (error: string): string => {
    if (error === "invalid_grant") {
        return "Microsoft no longer accepts this sign-in (it expired, was revoked, or a password or policy changed): run `m365 auth login` again";
    }
    if (error === "invalid_client" || error === "unauthorized_client") {
        return "Microsoft refused the application on this card: check the application (client) ID and tenant ID, and that public client flows are allowed";
    }
    if (error === "interaction_required" || error === "consent_required") {
        return "Microsoft wants the user (or an administrator) to approve this application again: run `m365 auth login`";
    }
    return `Microsoft refused to sign in (${error})`;
};

// The agent's CLI stores through the daemon with the agent token every agent-side CLI carries. A rotation another
// process stored first is fine: Microsoft keeps the older token valid, and the card's newer one stands.
export const saveToVault =
    (account: Account, options: AgentStoreOptions = {}): SaveToken =>
    async (refreshToken, previous, login) => {
        await storeRefreshTokenAsAgent({ id: account.id, binding: bindingOf(account), previous, refreshToken, login: login === true }, options);
    };

// One hour of access token, on disk 0600 under the extension's runtime tree, keyed by a hash of the credential so a
// rotated or re-entered card simply stops matching.
export interface TokenCache {
    readonly read: (fingerprint: string, now: number) => Promise<string | undefined>;
    readonly write: (fingerprint: string, token: string, until: number) => Promise<void>;
}

const fingerprintOf = (account: Account): string =>
    createHash("sha256")
        .update(
            JSON.stringify([
                account.tenantId,
                account.clientId,
                account.authority || DEFAULT_AUTHORITY,
                account.access ?? "",
                account.refreshToken ?? "",
            ]),
        )
        .digest("hex")
        .slice(0, 16);

export const fileTokenCache = (root: string, account: Account): TokenCache => {
    const path = join(root, extensionStateDir("intentic.microsoft-365"), account.id.replaceAll(/[^a-z0-9_-]/g, "_"), "token.json");
    return {
        read: async (fingerprint, now) => {
            try {
                // SAFETY: only this function writes the file; a hand-edited one fails the fingerprint and expiry checks.
                const cached = JSON.parse(await readFile(path, "utf8")) as { fingerprint?: string; token?: string; until?: number };
                return cached.fingerprint === fingerprint && (cached.until ?? 0) > now ? cached.token : undefined;
            } catch {
                // allow(silent-catch): no file, or a truncated one, is simply no cached token.
                return undefined;
            }
        },
        write: async (fingerprint, token, until) => {
            // allow(silent-catch): best effort, a full or read-only disk must not stop a command holding a good token
            await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
            // allow(silent-catch): as above; the next command simply mints again
            await writeFile(path, JSON.stringify({ fingerprint, token, until }), { mode: 0o600 }).catch(() => undefined);
        },
    };
};

const NO_CACHE: TokenCache = { read: async () => undefined, write: async () => undefined };

export interface TokenSessionOptions {
    readonly http?: Http;
    readonly now?: () => number;
    readonly cache?: TokenCache;
}

// The bearer for this hour: from memory, else the cache, else minted from the refresh token. Concurrent callers share
// one mint; a rotated refresh token is stored before it is used.
export const tokenSession = (account: Account, save: SaveToken, options: TokenSessionOptions = {}): (() => Promise<string>) => {
    const http = options.http ?? fetch;
    const now = options.now ?? Date.now;
    const cache = options.cache ?? NO_CACHE;
    const fingerprint = fingerprintOf(account);
    let refresh = account.refreshToken ?? "";
    let cached: { token: string; until: number } | undefined;
    let pending: Promise<string> | undefined;
    const mint = async (): Promise<string> => {
        if (!refresh) {
            throw new SignInError("Nobody has signed in with this card yet: run `m365 auth login` in a turn the office user is watching");
        }
        const form = new URLSearchParams({
            client_id: account.clientId,
            grant_type: "refresh_token",
            refresh_token: refresh,
            scope: scopesFor(account),
        });
        // A confidential app proves itself with its secret; a public client (device-code sign-in) has none.
        if (account.clientSecret) {
            form.set("client_secret", account.clientSecret);
        }
        const answer = await formCall<TokenAnswer>(http, tokenUrl(account), form);
        if (!answer.access_token || answer.error) {
            throw new SignInError(refusal(answer.error ?? "missing_token"));
        }
        if (answer.refresh_token && answer.refresh_token !== refresh) {
            await save(answer.refresh_token, refresh);
            refresh = answer.refresh_token;
        }
        // A token about to expire would fail mid-command, so it counts as gone a minute early.
        cached = { token: answer.access_token, until: now() + Math.max(0, (answer.expires_in ?? 3600) - 60) * 1000 };
        await cache.write(fingerprint, cached.token, cached.until);
        return cached.token;
    };
    const current = async (): Promise<string> => {
        const stored = await cache.read(fingerprint, now());
        return stored ?? mint();
    };
    return () => {
        if (cached !== undefined && now() < cached.until) {
            return Promise.resolve(cached.token);
        }
        pending ??= current().finally(() => {
            pending = undefined;
        });
        return pending;
    };
};

interface DeviceAnswer {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval?: number;
    error?: string;
}

export interface DeviceLoginOptions {
    readonly http?: Http;
    readonly pause?: (ms: number) => Promise<void>;
    readonly now?: () => number;
}

// Only Microsoft's own page may be printed for the person to open, and never Microsoft's `message`, which is server data
// rather than an instruction.
const verificationPage = (raw: string, authority: string): string => {
    const page = new URL(raw);
    const microsoft = ["microsoft.com", "www.microsoft.com"].includes(page.hostname) && page.pathname === "/devicelogin";
    const plain = page.protocol === "https:" && page.username === "" && page.password === "" && page.port === "";
    if (!plain || !(microsoft || page.hostname === authority)) {
        throw new Error("Microsoft answered with a sign-in page this CLI does not recognise");
    }
    return page.toString();
};

const startDevice = async (account: Account, http: Http): Promise<DeviceAnswer & { page: string }> => {
    if (account.clientSecret) {
        throw new Error(
            "Device-code sign-in needs a public client without a secret: leave Client secret blank on the card. A confidential app supplies a refresh token from its own authorization-code flow instead.",
        );
    }
    const { authority } = cloudOf(account);
    const device = await formCall<DeviceAnswer>(http, `https://${authority}/${encodeURIComponent(account.tenantId)}/oauth2/v2.0/devicecode`, {
        client_id: account.clientId,
        scope: scopesFor(account),
    });
    if (device.error !== undefined || !device.device_code) {
        throw new Error(refusal(device.error ?? "missing_code"));
    }
    return { ...device, page: verificationPage(device.verification_uri, authority) };
};

// Asks until the person finishes on Microsoft's page, the code expires, or Microsoft refuses; answers the refresh token.
const pollDevice = async (
    account: Account,
    device: DeviceAnswer,
    http: Http,
    pause: (ms: number) => Promise<void>,
    now: () => number,
): Promise<string> => {
    const deadline = now() + device.expires_in * 1000;
    let interval = Math.max(1, device.interval ?? 5) * 1000;
    const form = { client_id: account.clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code };
    while (now() < deadline) {
        await pause(interval);
        const answer = await formCall<TokenAnswer>(http, tokenUrl(account), form);
        if (answer.error === "slow_down") {
            interval += 5000;
        } else if (answer.error === "authorization_declined") {
            throw new Error("The sign-in was declined on Microsoft's page");
        } else if (answer.error !== "authorization_pending") {
            if (answer.error !== undefined || !answer.refresh_token) {
                throw new Error(refusal(answer.error ?? "no_refresh_token"));
            }
            return answer.refresh_token;
        }
    }
    throw new Error("The sign-in code expired before anyone used it: run `m365 auth login` again");
};

// Device-code sign-in: no redirect URI, so it works from a sandbox nobody can reach. The person opens Microsoft's own
// page in their own browser and types the short code; Conditional Access and MFA apply there as usual.
export const deviceLogin = async (
    account: Account,
    save: SaveToken,
    out: (line: string) => void,
    options: DeviceLoginOptions = {},
): Promise<void> => {
    const http = options.http ?? fetch;
    const device = await startDevice(account, http);
    out(`Open ${device.page} in your own browser, enter the code ${device.user_code} and sign in with the office account.`);
    const refreshToken = await pollDevice(account, device, http, options.pause ?? sleep, options.now ?? Date.now);
    await save(refreshToken, account.refreshToken ?? "", true);
    out("Signed in. The connection is stored on the Microsoft 365 card; commands in the next turn use it.");
};
