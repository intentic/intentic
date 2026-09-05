import { z } from "zod";
import type { MintedCredential, MintedLoginAttempt, MintedLoginContext, MintedLoginDriver } from "./minted-login.js";

/* META'S SIGN-IN: the Muse Code device flow, then the exchange that turns its token into a key that can
 * actually run a turn.
 *
 * It is RFC 8628 by the book — ask for a device code, show the user a short code and a page, poll the token
 * endpoint until they approve — with one vendor-specific step at the end. The token the device flow issues is a
 * `dca:` device credential, and Meta's model endpoint refuses it; the official Muse Code client posts it to
 * `/muse-code/key`, which answers with the `LLM|…` key the plan's requests are actually made with. That
 * exchange is the reason this provider can be connected without anybody visiting a dashboard, and it is also
 * where we find out whose account it is and whether the plan is live, because the mint answers with both.
 *
 * The client id below is Meta's own CLI's, and the user agent is that CLI's too: the endpoint is the one the
 * vendor ships for a terminal to sign in through, and it answers a request that looks like one. Both are
 * VENDOR FACTS, not configuration — nothing here is a knob for an owner to turn — so they are constants, and the
 * hosts are overridable in one place for the tests alone. */

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

// Muse Code's own client id and user agent. The device endpoints are the vendor's terminal sign-in road, and
// this is the client that road exists for.
const CLIENT_ID = "1031625952748946";
const USER_AGENT = "muse-code/1.0.2";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// The floor for how often the token endpoint is asked, and the step a `slow_down` adds. RFC 8628 says the
// server's own `interval` governs; these are what we do when it says nothing, and what we add when it says we
// are asking too fast.
const MIN_POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_STEP_MS = 5_000;
// One control request against a vendor's auth server. Generous for a cold edge, bounded so a hung socket cannot
// hold a poll tick open past the next one.
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

/* What the mint answers, and the three fields past the key are why this is worth parsing rather than reading
 * `api_key` and moving on. `user_email` is the only thing that can name the row (a minted key says nothing
 * about whose it is), and `require_payment` is Meta telling us the account has no live plan — which is worth
 * refusing on, because storing that key would draw a connected row whose every turn is refused for a reason
 * the row cannot show. */
const MintedKeySchema = z.object({
    api_key: z.string().default(""),
    user_email: z.string().default(""),
    is_subs_active: z.boolean().optional(),
    require_payment: z.boolean().optional(),
});

/* WHAT ONE POLL TICK MEANT, as four answers rather than a chain of ifs inside the loop, and every ending said
 * in the vendor's own terms — because "the sign-in failed" is the one answer that helps nobody. An expired code
 * means start again, a declined one means the person said no on the page, a `slow_down` means keep going more
 * slowly, and anything else is Meta's own words passed through.
 *
 * A body that will not parse reads as `pending`, deliberately: a proxy's error page on one tick is not the
 * vendor declining a sign-in, and the deadline is what ends the wait.
 *
 * Exported for the test, which is the only way to assert the RFC's own vocabulary is honoured without standing
 * up a device flow per case. */
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

        // The poll: one tick a time, until the vendor's own deadline. What a tick MEANT is verdictOf's
        // business, so this reads as the three things that can happen and nothing else.
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
                // A blip on one tick is not an outcome: the next tick asks again, and the vendor's own deadline
                // is what ends this loop.
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

/* THE EXCHANGE. Named as its own step because it is the one that fails in a way the user can do something
 * about: the device flow succeeding proves they signed in, and this failing means the account behind that
 * sign-in has no live Muse Code plan. Saying which of the two happened is the whole value of the message. */
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
        // The vendor is saying the account has to pay before it can run anything. Storing the key anyway would
        // draw a connected row that refuses every turn, with the reason living only in the refusal.
        throw new Error("That Meta account has no active Muse Code plan: subscribe, then connect it here.");
    }
    return { apiKey: minted.data.api_key, ...(minted.data.user_email !== "" ? { email: minted.data.user_email } : {}) };
};
