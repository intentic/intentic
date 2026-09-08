import { z } from "zod";
import type { MintedCredential, MintedLoginAttempt, MintedLoginContext, MintedLoginDriver } from "./minted-login.js";

// Meta's sign-in: RFC 8628 device flow, then an exchange that turns the dca: device token (which Meta's model endpoint
// refuses) into the LLM|… key a turn actually runs on, via Muse Code's own /muse-code/key. The client id and user agent
// are Meta's official CLI's, vendor facts rather than configuration, so they're constants; the hosts are overridable in
// one place for tests.

export interface MetaLoginHosts {
    readonly deviceAuthorization: string;
    readonly token: string;
    readonly mint: string;
}

export const META_LOGIN_HOSTS: MetaLoginHosts = {
    deviceAuthorization: "https://auth.meta.com/oidc/device/authorization/",
    token: "https://auth.meta.com/oidc/device/token/",
    mint: "https://api.meta.ai/muse-code/key",
};

// Muse Code's own client id and user agent; the vendor's terminal sign-in road exists for this client.
const CLIENT_ID = "1031625952748946";
const USER_AGENT = "muse-code/1.0.2";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// Used when the server's RFC 8628 `interval` says nothing, and added when it says `slow_down`.
const MIN_POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_STEP_MS = 5_000;
// Bounded so a hung socket can't hold a poll tick open past the next one.
const REQUEST_TIMEOUT_MS = 30_000;

const DeviceCodeSchema = z.object({
    device_code: z.string().min(1),
    user_code: z.string().default(""),
    verification_uri: z.string().default(""),
    verification_uri_complete: z.string().default(""),
    expires_in: z.number().default(600),
    interval: z.number().default(5),
});

const TokenSchema = z.object({
    access_token: z.string().default(""),
    error: z.string().default(""),
    error_description: z.string().default(""),
});

// user_email is the only way to name the row (a key says nothing about whose it is); require_payment means the account
// has no live plan, worth refusing on rather than storing a row that fails every turn silently.
const MintedKeySchema = z.object({
    api_key: z.string().default(""),
    user_email: z.string().default(""),
    is_subs_active: z.boolean().optional(),
    require_payment: z.boolean().optional(),
});

// One poll tick's outcome, in the vendor's own terms rather than a generic failure. An unparseable body reads as
// `pending`, not a decline: a proxy error on one tick isn't a vendor refusal, and the deadline ends the wait.
export type MetaPollVerdict =
    | { readonly kind: "granted"; readonly deviceToken: string }
    | { readonly kind: "pending" }
    | { readonly kind: "slower" }
    | { readonly kind: "failed"; readonly message: string };

export const verdictOf = (ok: boolean, body: unknown): MetaPollVerdict => {
    const token = TokenSchema.safeParse(body);
    if (!token.success) {
        return { kind: "pending" };
    }
    const { access_token, error, error_description } = token.data;
    if (ok && access_token !== "") {
        return { kind: "granted", deviceToken: access_token };
    }
    switch (error) {
        case "authorization_pending":
        case "":
            return { kind: "pending" };
        case "slow_down":
            return { kind: "slower" };
        case "access_denied":
            return { kind: "failed", message: "The Meta sign-in was declined on the page." };
        case "expired_token":
            return { kind: "failed", message: "The Meta sign-in expired before it was approved: start it again." };
        default:
            return { kind: "failed", message: error_description !== "" ? error_description : `Meta refused the sign-in (${error}).` };
    }
};

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT };

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });

export const metaLoginDriver =
    (hosts: MetaLoginHosts = META_LOGIN_HOSTS): MintedLoginDriver =>
    async (context: MintedLoginContext): Promise<MintedLoginAttempt> => {
        const { fetchImpl, signal } = context;
        const started = await fetchImpl(hosts.deviceAuthorization, {
            method: "POST",
            headers,
            body: form({ client_id: CLIENT_ID }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }).catch((error: unknown) => {
            throw new Error("Meta's sign-in service could not be reached.", { cause: error });
        });
        if (!started.ok) {
            throw new Error(`Meta refused to start the sign-in (${started.status}).`);
        }
        const device = DeviceCodeSchema.safeParse(await started.json().catch(() => undefined));
        if (!device.success) {
            throw new Error("Meta's sign-in service answered with no device code.");
        }
        const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = device.data;
        const url = verification_uri_complete !== "" ? verification_uri_complete : verification_uri;
        if (url === "") {
            throw new Error("Meta's sign-in service answered with no page to open.");
        }

        // Polls one tick at a time until the vendor's deadline; verdictOf decides what a tick meant.
        const settle = async (): Promise<MintedCredential> => {
            let intervalMs = Math.max(MIN_POLL_INTERVAL_MS, interval * 1_000);
            const deadline = Date.now() + expires_in * 1_000;
            while (Date.now() < deadline) {
                await sleep(intervalMs, signal);
                if (signal.aborted) {
                    throw new Error("The Meta sign-in was abandoned.");
                }
                const response = await fetchImpl(hosts.token, {
                    method: "POST",
                    headers,
                    body: form({ grant_type: DEVICE_CODE_GRANT, device_code, client_id: CLIENT_ID }),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                }).catch(() => undefined);
                // A blip on one tick is not an outcome: the next tick asks again, and the vendor's own deadline is what
                // ends this loop.
                const verdict =
                    response === undefined ? ({ kind: "pending" } as const) : verdictOf(response.ok, await response.json().catch(() => undefined));
                if (verdict.kind === "granted") {
                    return await mintKey({ fetchImpl, hosts, deviceToken: verdict.deviceToken });
                }
                if (verdict.kind === "failed") {
                    throw new Error(verdict.message);
                }
                if (verdict.kind === "slower") {
                    intervalMs += SLOW_DOWN_STEP_MS;
                }
            }
            throw new Error("The Meta sign-in expired before it was approved: start it again.");
        };

        return { url, code: user_code, state: "", expiresAt: Date.now() + expires_in * 1_000, settle };
    };

// The exchange: a separate step because it fails differently than the device flow. Success there proves sign-in;
// failure here means the account has no live Muse Code plan.
const mintKey = async (input: {
    readonly fetchImpl: typeof fetch;
    readonly hosts: MetaLoginHosts;
    readonly deviceToken: string;
}): Promise<MintedCredential> => {
    const response = await input
        .fetchImpl(input.hosts.mint, {
            method: "POST",
            headers: {
                authorization: `Bearer ${input.deviceToken}`,
                "content-type": "application/json",
                accept: "application/json",
                "user-agent": USER_AGENT,
            },
            body: JSON.stringify({ dca_token: input.deviceToken }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        .catch((error: unknown) => {
            throw new Error("Signed in, but Meta could not be reached to issue this sandbox's key.", { cause: error });
        });
    if (!response.ok) {
        throw new Error(`Signed in, but Meta would not issue a key for that account (${response.status}).`);
    }
    const minted = MintedKeySchema.safeParse(await response.json().catch(() => undefined));
    if (!minted.success || minted.data.api_key === "") {
        throw new Error("Signed in, but Meta issued no key for that account.");
    }
    if (minted.data.require_payment === true) {
        // Storing the key anyway would draw a connected row that refuses every turn, the reason visible only in that
        // refusal.
        throw new Error("That Meta account has no active Muse Code plan: subscribe, then connect it here.");
    }
    return { apiKey: minted.data.api_key, ...(minted.data.user_email !== "" ? { email: minted.data.user_email } : {}) };
};
