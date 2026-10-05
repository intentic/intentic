import { errorMessage } from "@intentic/base/errors";
import type { PushNotification } from "@intentic/sandbox-contract";
import { createSign } from "node:crypto";
import type { Config } from "../config.js";
import type { ApnsForwarder, ApnsOutcome } from "./apns.js";

// The FCM forwarder, the only place that speaks Firebase Cloud Messaging. Its one job is waking the Intentic Device
// app on a phone: an Android row on the relay is a WAKE channel, not a notification channel (the editor itself reaches
// Android through web push), so whatever the daemon sends, the phone gets a data-only, high-priority message that
// carries nothing but `kind: "wake"`. The title and body never leave the platform, and the app shows nothing for it.
// Same verdicts as apns.ts: delivered, dead (the token will never work again, the caller deletes the row), transient.

// Google's access tokens last an hour; one minted per send would be rate-limited, so it is kept until near its end.
const TOKEN_MARGIN_MS = 5 * 60_000;

// Under the daemon's own relay timeout (10s), like APNs's.
const REQUEST_TIMEOUT_MS = 8_000;

// How long FCM keeps trying to deliver a wake: a phone that comes back an hour later has no turn waiting on it.
const WAKE_TTL = "60s";

// The fields of a Firebase service account's JSON key this forwarder reads.
interface ServiceAccount {
    readonly project_id: string;
    readonly client_email: string;
    readonly private_key: string;
    readonly private_key_id?: string;
    readonly token_uri?: string;
}

const parseAccount = (raw: string): ServiceAccount | undefined => {
    try {
        const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
        return typeof parsed.project_id === "string" && typeof parsed.client_email === "string" && typeof parsed.private_key === "string"
            ? (parsed as ServiceAccount)
            : undefined;
    } catch {
        return undefined;
    }
};

const base64url = (data: string): string => Buffer.from(data).toString("base64url");

// The OAuth 2.0 JWT-bearer assertion Google trades for an access token, signed RS256 with node:crypto.
export const signAssertion = (account: ServiceAccount, nowSeconds: number): string => {
    const header = base64url(
        JSON.stringify({ alg: "RS256", typ: "JWT", ...(account.private_key_id === undefined ? {} : { kid: account.private_key_id }) }),
    );
    const claims = base64url(
        JSON.stringify({
            iss: account.client_email,
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
            iat: nowSeconds,
            exp: nowSeconds + 3600,
        }),
    );
    const input = `${header}.${claims}`;
    const signature = createSign("RSA-SHA256").update(input).sign(account.private_key.replace(/\\n/g, "\n"));
    return `${input}.${signature.toString("base64url")}`;
};

// FCM's error codes for a token that will never be delivered to again: the app was uninstalled, or the token is not
// one (a pasted fragment, another project's).
const DEAD_CODES = new Set(["UNREGISTERED", "INVALID_ARGUMENT", "SENDER_ID_MISMATCH"]);

const errorCodeOf = (body: unknown): string | undefined => {
    const details = (body as { error?: { details?: { errorCode?: unknown }[]; status?: unknown } } | undefined)?.error;
    const detailed = details?.details?.find((detail) => typeof detail.errorCode === "string")?.errorCode;
    return typeof detailed === "string" ? detailed : typeof details?.status === "string" ? details.status : undefined;
};

export const createFcmForwarder = (config: Config, fetcher: typeof fetch = fetch): ApnsForwarder => {
    const account = parseAccount(config.fcm.serviceAccount);
    if (account === undefined) {
        return { enabled: false, send: async () => ({ verdict: "transient", reason: "no FCM service account is configured" }) };
    }

    let cached: { token: string; until: number } | undefined;
    const accessToken = async (): Promise<string> => {
        if (cached !== undefined && Date.now() < cached.until) {
            return cached.token;
        }
        const response = await fetcher(account.token_uri ?? "https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: signAssertion(account, Math.floor(Date.now() / 1000)),
            }).toString(),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`Google refused the service account (${response.status})`);
        }
        const answer = (await response.json()) as { access_token?: string; expires_in?: number };
        if (typeof answer.access_token !== "string") {
            throw new Error("Google answered without an access token");
        }
        cached = { token: answer.access_token, until: Date.now() + (answer.expires_in ?? 3600) * 1000 - TOKEN_MARGIN_MS };
        return answer.access_token;
    };

    const send = async (token: string, notification: PushNotification): Promise<ApnsOutcome> => {
        const tag = notification.tag ?? "wake";
        try {
            const response = await fetcher(`${config.fcm.url}/v1/projects/${account.project_id}/messages:send`, {
                method: "POST",
                headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
                body: JSON.stringify({
                    message: { token, data: { kind: "wake", tag }, android: { priority: "HIGH", ttl: WAKE_TTL, collapse_key: tag } },
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (response.ok) {
                return { verdict: "delivered" };
            }
            // allow(silent-catch): an error body that is not JSON carries no code, and the status alone decides below
            const code = errorCodeOf(await response.json().catch(() => undefined));
            if (response.status === 404 || (code !== undefined && DEAD_CODES.has(code))) {
                return { verdict: "dead" };
            }
            return { verdict: "transient", reason: `FCM answered ${response.status}${code === undefined ? "" : ` ${code}`}` };
        } catch (error) {
            return { verdict: "transient", reason: errorMessage(error) };
        }
    };

    return { enabled: true, send };
};
