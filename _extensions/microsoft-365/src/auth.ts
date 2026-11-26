import { sleep } from "@intentic/base/async";
import { type Account, cloudOf, scopesFor } from "./accounts.js";

// Sign-in and token upkeep for one card. The refresh token lives only on the card (the daemon's vault) and in the memory
// of the extension's own processes, its backend and its inbox watcher: a sign-in or a rotation is written back through
// the daemon's oauth-token route, never printed and never put in a file. The backend keeps each card's one-hour access
// token in memory, so a run of commands does not mint (and rotate) on every call (server.ts).

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

export interface TokenSessionOptions {
    readonly http?: Http;
    readonly now?: () => number;
}

// The bearer for this hour: from memory, else minted from the refresh token. Concurrent callers share one mint; a
// rotated refresh token is stored before it is used.
export const tokenSession = (account: Account, save: SaveToken, options: TokenSessionOptions = {}): (() => Promise<string>) => {
    const http = options.http ?? fetch;
    const now = options.now ?? Date.now;
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
        return cached.token;
    };
    return () => {
        if (cached !== undefined && now() < cached.until) {
            return Promise.resolve(cached.token);
        }
        pending ??= mint().finally(() => {
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
// rather than an instruction. Microsoft answers with `login.microsoft.com/device` today and `microsoft.com/devicelogin`
// (its national clouds' variants included) before; a national cloud may answer with a page on its own sign-in host.
const verificationPage = (raw: string, authority: string): string => {
    const page = new URL(raw);
    const microsoft = ["microsoft.com", "www.microsoft.com", "login.microsoft.com"].includes(page.hostname);
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
