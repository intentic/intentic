import { errorMessage } from "@intentic/base/errors";
import { parseJsonOr } from "@intentic/base/json";
import type { PushApp } from "@intentic/api-contract";
import type { PushNotification } from "@intentic/sandbox-contract/schemas/push";
import { createSign } from "node:crypto";
import type { Config } from "../config.js";
import type { ApnsOutcome } from "./apns.js";

// The FCM forwarder, the only place that speaks Firebase Cloud Messaging. Every message it sends is data-only: the
// title and body never leave the platform, whichever of the two Android apps holds the token (the row's `app`).
// - device: the Intentic Device app, WOKEN. It gets nothing but `kind: "wake"`, dials its sandbox and shows nothing.
// - editor: the native editor app (dev.intentic.app), told `kind: "notify"` with what it needs to fetch the words from
//   the daemon over its own session (`GET /push/notification?tag=`) and draw the notification itself: the tag, the
//   in-app path, the sandbox it registered for, and whether the notification asks to stay or to arrive silent.
// Both apps live in the one Firebase project, so one service account sends to either's tokens.
// Same verdicts as apns.ts: delivered, dead (the token will never work again, the caller deletes the row), transient.

// What the relay's row says about a token beyond the token: which app holds it, and the sandbox an editor registration
// named ("" or absent when none).
export interface RelayRow {
    readonly app: PushApp;
    readonly sandbox?: string;
}

// A forwarder the relay hands its row to. APNs reads only the token, so createApnsForwarder fits it as it is.
export interface PushForwarder {
    readonly enabled: boolean;
    readonly send: (token: string, notification: PushNotification, row: RelayRow) => Promise<ApnsOutcome>;
}

// Google's access tokens last an hour; one minted per send would be rate-limited, so it is kept until near its end.
const TOKEN_MARGIN_MS = 5 * 60_000;

// Under the daemon's own relay timeout (10s), like APNs's.
const REQUEST_TIMEOUT_MS = 8_000;

// How long FCM keeps trying to deliver a wake: a phone that comes back an hour later has no turn waiting on it.
const WAKE_TTL = "60s";

// How long FCM keeps an editor notify for a phone that is off or out of reach. Hours, because what it points at is
// still true when it arrives late: the app reads the state from the daemon as it lands, so an ask answered meanwhile
// draws as settled rather than as a stale question. Six covers a flight or a day in a dead zone; a finished turn older
// than that is no longer news, and anything still waiting is on the board anyway.
const NOTIFY_TTL = "21600s";

// The Device app's whole message: wake up, under this tag.
interface WakeData {
    readonly kind: "wake";
    readonly tag: string;
}

// What an editor app is told: never a word of the notification, only what it needs to fetch and draw it. FCM data
// values are strings only, so a flag rides as "true" and is left out when false.
interface NotifyData {
    kind: "notify";
    tag: string;
    url?: string;
    sandbox?: string;
    requireInteraction?: "true";
    silent?: "true";
}

// The part of an FCM HTTP v1 `Message` this forwarder fills.
interface FcmMessage {
    readonly token: string;
    readonly data: WakeData | NotifyData;
    readonly android: { readonly priority: "HIGH" | "NORMAL"; readonly ttl: string; readonly collapse_key: string };
}

const notifyData = (notification: PushNotification, row: RelayRow, tag: string): NotifyData => {
    const data: NotifyData = { kind: "notify", tag };
    if (notification.url !== undefined) {
        data.url = notification.url;
    }
    if (row.sandbox !== undefined && row.sandbox !== "") {
        data.sandbox = row.sandbox;
    }
    if (notification.requireInteraction === true) {
        data.requireInteraction = "true";
    }
    if (notification.silent === true) {
        data.silent = "true";
    }
    return data;
};

// The FCM message for one row. A notify's priority is HIGH so a dozing phone wakes to show it, except a silent one (a
// withdrawn ask's replacement), which shows nothing new: Android demotes an app whose high-priority messages draw no
// notification, and a withdrawal can wait for the phone's next window.
const messageFor = (token: string, notification: PushNotification, row: RelayRow): FcmMessage => {
    if (row.app !== "editor") {
        const tag = notification.tag ?? "wake";
        return { token, data: { kind: "wake", tag }, android: { priority: "HIGH", ttl: WAKE_TTL, collapse_key: tag } };
    }
    const tag = notification.tag ?? "intentic";
    return {
        token,
        data: notifyData(notification, row, tag),
        android: { priority: notification.silent === true ? "NORMAL" : "HIGH", ttl: NOTIFY_TTL, collapse_key: tag },
    };
};

// The fields of a Firebase service account's JSON key this forwarder reads.
interface ServiceAccount {
    readonly project_id: string;
    readonly client_email: string;
    readonly private_key: string;
    readonly private_key_id?: string;
    readonly token_uri?: string;
}

// A key that is not JSON is as unusable as one missing its fields; the caller reports both as no service account.
const parseAccount = (raw: string): ServiceAccount | undefined => {
    // SAFETY: the three fields signing needs are checked by type below before the account is believed.
    const parsed = parseJsonOr(raw, undefined) as Partial<ServiceAccount> | null | undefined;
    return typeof parsed?.project_id === "string" && typeof parsed.client_email === "string" && typeof parsed.private_key === "string"
        ? (parsed as ServiceAccount)
        : undefined;
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

export const createFcmForwarder = (config: Config, fetcher: typeof fetch = fetch): PushForwarder => {
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

    const send = async (token: string, notification: PushNotification, row: RelayRow): Promise<ApnsOutcome> => {
        try {
            const response = await fetcher(`${config.fcm.url}/v1/projects/${account.project_id}/messages:send`, {
                method: "POST",
                headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
                body: JSON.stringify({ message: messageFor(token, notification, row) }),
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
