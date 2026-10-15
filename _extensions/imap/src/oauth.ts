import { sleep } from "@intentic/base/async";
// OAuth2 for IMAP and SMTP (SASL XOAUTH2), the alternative to a password where a provider has switched passwords off:
// Exchange Online always, Gmail for accounts without app passwords. The card holds either a refresh token the mailbox
// owner signed in for (Microsoft's device-code sign-in stores it there by itself; a Google one is pasted), from which a
// fresh access token is minted for each connection and each send, or an access token someone else keeps current.

export type OAuthProvider = "microsoft" | "google" | "token";

// The card's sign-in settings, as its fields name them.
export interface OAuthSettings {
    readonly username: string;
    readonly oauthProvider?: string | undefined;
    readonly oauthTenant?: string | undefined;
    readonly oauthClientId?: string | undefined;
    readonly oauthClientSecret?: string | undefined;
    readonly oauthRefreshToken?: string | undefined;
    readonly accessToken?: string | undefined;
}

export type Http = (url: string, init?: RequestInit) => Promise<Response>;
// Stores a rotated refresh token on the card; `previous` is the one this process held.
export type SaveToken = (token: string, previous: string, login?: boolean) => Promise<void>;

// One Exchange Online token serves both protocols: both permissions belong to the same resource.
export const MICROSOFT_SCOPES = "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const providerOf = (settings: OAuthSettings): OAuthProvider =>
    settings.oauthProvider === "google" || settings.oauthProvider === "token" ? settings.oauthProvider : "microsoft";

// A refusal only a new sign-in or a corrected card fixes; the watcher treats it as fatal, like a wrong password.
export class OAuthRefusedError extends Error {}

const microsoftAuthority = (settings: OAuthSettings): string => {
    const tenant = settings.oauthTenant ?? "";
    if (!/^[a-zA-Z0-9.-]+$/.test(tenant)) {
        throw new OAuthRefusedError("Set the directory (tenant) ID on the IMAP card");
    }
    return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
};

export const tokenUrl = (settings: OAuthSettings): string =>
    providerOf(settings) === "google" ? GOOGLE_TOKEN_URL : `${microsoftAuthority(settings)}/token`;

// What the card held when its token was minted; the daemon refuses to store a token once any of these changed. A type
// rather than an interface: the daemon's route takes it as a plain record of field values.
export type OAuthBinding = {
    readonly oauthProvider: string;
    readonly oauthTenant: string;
    readonly oauthClientId: string;
    readonly username: string;
};

export const bindingOf = (settings: OAuthSettings): OAuthBinding => ({
    oauthProvider: providerOf(settings),
    oauthTenant: settings.oauthTenant ?? "",
    oauthClientId: settings.oauthClientId ?? "",
    username: settings.username,
});

interface TokenAnswer {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
}

// An authority's error body may echo a credential: only its protocol error code and the status leave this module.
const postForm = async (http: Http, url: string, form: URLSearchParams): Promise<TokenAnswer> => {
    const response = await http(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
    });
    try {
        // SAFETY: every field of a token answer is optional in its type and checked before it is used.
        const answer = (await response.json()) as TokenAnswer;
        if (!response.ok && answer.error === undefined) {
            throw new OAuthRefusedError(`the sign-in service answered ${response.status}`);
        }
        return answer;
    } catch (error) {
        throw error instanceof OAuthRefusedError ? error : new Error("the sign-in service answered something unreadable");
    }
};

const refusal = (provider: OAuthProvider, error: string): OAuthRefusedError =>
    new OAuthRefusedError(
        error === "invalid_grant"
            ? provider === "microsoft"
                ? "Microsoft no longer accepts the mailbox sign-in on the IMAP card: run `imap login` again"
                : "Google no longer accepts the refresh token on the IMAP card: paste a fresh one"
            : `the mailbox sign-in was refused (${error})`,
    );

export interface MintOptions {
    readonly http?: Http;
    readonly save?: SaveToken;
}

// A fresh access token for one connection or one send. A rotated refresh token is stored before the access token is
// used, so the card never falls behind Microsoft.
export const mintAccessToken = async (settings: OAuthSettings, options: MintOptions = {}): Promise<string> => {
    const provider = providerOf(settings);
    if (provider === "token") {
        if (!settings.accessToken) {
            throw new OAuthRefusedError("The IMAP card's access token is empty");
        }
        return settings.accessToken;
    }
    const refreshToken = settings.oauthRefreshToken ?? "";
    if (refreshToken === "" || !settings.oauthClientId) {
        throw new OAuthRefusedError(
            provider === "microsoft"
                ? "Nobody has signed in to this mailbox yet: run `imap login` in a turn the owner is watching"
                : "Set the OAuth client ID and paste a refresh token on the IMAP card",
        );
    }
    const form = new URLSearchParams({ grant_type: "refresh_token", client_id: settings.oauthClientId, refresh_token: refreshToken });
    if (provider === "microsoft") {
        form.set("scope", MICROSOFT_SCOPES);
    }
    if (settings.oauthClientSecret) {
        form.set("client_secret", settings.oauthClientSecret);
    }
    const answer = await postForm(options.http ?? fetch, tokenUrl(settings), form);
    if (answer.error !== undefined || !answer.access_token) {
        throw refusal(provider, answer.error ?? "no_access_token");
    }
    if (answer.refresh_token && answer.refresh_token !== refreshToken) {
        await options.save?.(answer.refresh_token, refreshToken);
    }
    return answer.access_token;
};

export interface DeviceOptions {
    readonly http?: Http;
    readonly pause?: (ms: number) => Promise<void>;
    readonly now?: () => number;
}

// Only Microsoft's own page is printed for the person to open, never Microsoft's `message`, which is server data.
const verificationPage = (raw: string | undefined): string => {
    const page = new URL(raw ?? "");
    const known = ["microsoft.com", "www.microsoft.com", "login.microsoftonline.com"].includes(page.hostname);
    if (page.protocol !== "https:" || page.username !== "" || page.password !== "" || page.port !== "" || !known) {
        throw new Error("Microsoft answered with a sign-in page this CLI does not recognise");
    }
    return page.toString();
};

const pollDevice = async (settings: OAuthSettings, device: TokenAnswer, options: DeviceOptions): Promise<string> => {
    const now = options.now ?? Date.now;
    const deadline = now() + (device.expires_in ?? 0) * 1000;
    let interval = Math.max(1, device.interval ?? 5) * 1000;
    const form = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: settings.oauthClientId ?? "",
        device_code: device.device_code ?? "",
    });
    while (now() < deadline) {
        await (options.pause ?? sleep)(interval);
        const answer = await postForm(options.http ?? fetch, tokenUrl(settings), form);
        if (answer.error === "slow_down") {
            interval += 5000;
        } else if (answer.error !== "authorization_pending") {
            if (answer.error !== undefined || !answer.refresh_token) {
                throw refusal("microsoft", answer.error ?? "no_refresh_token");
            }
            return answer.refresh_token;
        }
    }
    throw new Error("The sign-in code expired before anyone used it: run `imap login` again");
};

// Exchange Online's sign-in without a redirect address: the mailbox owner opens Microsoft's page in their own browser
// and types a short code. The refresh token goes straight onto the card through `save`, never to the output.
export const deviceLogin = async (
    settings: OAuthSettings,
    save: SaveToken,
    out: (line: string) => void,
    options: DeviceOptions = {},
): Promise<void> => {
    if (providerOf(settings) !== "microsoft") {
        throw new Error("`imap login` signs in to Exchange Online; for Gmail paste a refresh token on the card");
    }
    if (settings.oauthClientSecret || !settings.oauthClientId) {
        throw new Error("Device-code sign-in needs the app's client ID and no client secret (a public client): check the IMAP card");
    }
    const device = await postForm(
        options.http ?? fetch,
        `${microsoftAuthority(settings)}/devicecode`,
        new URLSearchParams({ client_id: settings.oauthClientId, scope: MICROSOFT_SCOPES }),
    );
    if (device.error !== undefined || !device.device_code) {
        throw refusal("microsoft", device.error ?? "no_device_code");
    }
    out(
        `Open ${verificationPage(device.verification_uri)} in your own browser, enter the code ${device.user_code ?? ""} and sign in as ${settings.username}.`,
    );
    await save(await pollDevice(settings, device, options), settings.oauthRefreshToken ?? "", true);
    out("Signed in. The mailbox sign-in is stored on the IMAP card; the watcher and the next turn use it.");
};
