import type { PushNotification } from "@intentic/sandbox-contract";
import { createPrivateKey, createSign } from "node:crypto";
import { connect, constants } from "node:http2";
import type { Config } from "../config.js";

// The APNs forwarder, the only place that speaks Apple; the verdict split the daemon's pruning depends on:
// delivered: APNs took it.
// dead: the device is gone for good, so the caller deletes the row.
// transient: everything else, including our own bad credential.

export type ApnsVerdict = "delivered" | "dead" | "transient";

export interface ApnsForwarder {
    // False with no APNs key set; the relay's routes then 404, like the platform's other credential-switched lanes.
    readonly enabled: boolean;
    readonly send: (token: string, notification: PushNotification) => Promise<ApnsVerdict>;
}

// Apple wants provider tokens 20-60 minutes old; re-signing every send would be rejected as too frequent.
const JWT_LIFETIME_MS = 50 * 60_000;

// Must never hold a daemon's fan-out longer than the daemon's own relay timeout (10s), or the answer is wasted.
const REQUEST_TIMEOUT_MS = 8_000;

// Reasons Apple gives for a token that will never work again; everything else is our problem or a passing one.
const DEAD_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

// Env vars often carry the .p8 with literal \n; normalize so both paste styles load.
const pem = (raw: string): string => raw.replace(/\\n/g, "\n");

const base64url = (data: string): string => Buffer.from(data).toString("base64url");

// Signed with node:crypto rather than a JWT library: `dsaEncoding: ieee-p1363` gives the raw r-parallel-s signature
// JOSE requires.
const signProviderToken = (keyPem: string, keyId: string, teamId: string): string => {
    const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
    const input = `${header}.${payload}`;
    const signature = createSign("SHA256")
        .update(input)
        .sign({ key: createPrivateKey(keyPem), dsaEncoding: "ieee-p1363" });
    return `${input}.${signature.toString("base64url")}`;
};

export const createApnsForwarder = (config: Config): ApnsForwarder => {
    const { keyP8, keyId, teamId, bundleId, url } = config.apns;
    if (keyP8 === "") {
        return { enabled: false, send: async () => "transient" };
    }

    // One signed provider token serves every send until it ages out.
    let cached: { jwt: string; mintedAt: number } | undefined;
    const providerToken = (): string => {
        if (cached !== undefined && Date.now() - cached.mintedAt < JWT_LIFETIME_MS) {
            return cached.jwt;
        }
        cached = { jwt: signProviderToken(pem(keyP8), keyId, teamId), mintedAt: Date.now() };
        return cached.jwt;
    };

    // One HTTP/2 session per send; notifications are rare and Apple closes idle sessions itself anyway.
    const post = (jwt: string, token: string, body: string, collapseId: string | undefined): Promise<{ status: number; reason: string }> =>
        new Promise((resolve, reject) => {
            const session = connect(url);
            session.on("error", reject);
            const headers: Record<string, string> = {
                [constants.HTTP2_HEADER_METHOD]: "POST",
                [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
                authorization: `bearer ${jwt}`,
                "apns-topic": bundleId,
                "apns-push-type": "alert",
                "apns-priority": "10",
                // Matches the web-push transport's TTL: a stale attention notification is worse delivered late than
                // dropped.
                "apns-expiration": String(Math.floor(Date.now() / 1000) + 600),
            };
            if (collapseId !== undefined) {
                headers["apns-collapse-id"] = collapseId;
            }
            const request = session.request(headers);
            request.setTimeout(REQUEST_TIMEOUT_MS, () => {
                request.close(constants.NGHTTP2_CANCEL);
                session.close();
                reject(new Error("apns request timed out"));
            });
            let status = 0;
            request.on("response", (response) => {
                status = Number(response[constants.HTTP2_HEADER_STATUS]);
            });
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                session.close();
                let reason = "";
                try {
                    reason = String((JSON.parse(Buffer.concat(chunks).toString()) as { reason?: string }).reason ?? "");
                } catch {
                    reason = "";
                }
                resolve({ status, reason });
            });
            request.on("error", (error) => {
                session.close();
                reject(error);
            });
            request.end(body);
        });

    const send = async (token: string, notification: PushNotification): Promise<ApnsVerdict> => {
        // tag is both the collapse id (replaces an earlier one) and the thread id; no APNs match for requireInteraction
        const body = JSON.stringify({
            aps: {
                alert: { title: notification.title, body: notification.body },
                sound: "default",
                ...(notification.tag === undefined ? {} : { "thread-id": notification.tag }),
            },
            ...(notification.url === undefined ? {} : { url: notification.url }),
        });
        try {
            const { status, reason } = await post(providerToken(), token, body, notification.tag);
            if (status === 200) {
                return "delivered";
            }
            if (status === 410 || DEAD_REASONS.has(reason)) {
                return "dead";
            }
            return "transient";
        } catch {
            return "transient";
        }
    };

    return { enabled: true, send };
};
