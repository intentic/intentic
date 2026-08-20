import type { PushNotification } from "@intentic/sandbox-contract";
import { createPrivateKey, createSign } from "node:crypto";
import { connect, constants } from "node:http2";
import type { Config } from "../config.js";

/* The APNs forwarder — the one place in the platform that speaks Apple. Everything above it (the routes)
 * deals in the daemon's own notification shape and three verdicts; everything below this file is Apple's
 * HTTP/2 surface and stays here.
 *
 * The verdict split is the contract the daemon's pruning rests on, so it is worth being precise about:
 *   delivered  APNs took it.
 *   dead       APNs said the DEVICE can never be reached again (uninstalled, token rotated). The caller
 *              deletes the row and answers the daemon with a dead code.
 *   transient  everything else — including Apple refusing OUR credential. A misconfigured key must read as
 *              "the relay is down", never as "prune every iPhone", which is what conflating these would do. */

export type ApnsVerdict = "delivered" | "dead" | "transient";

export interface ApnsForwarder {
    // False when no APNs key is configured — the relay's routes 404, matching the platform's other
    // credential-switched lanes (hosted, pool, wallet).
    readonly enabled: boolean;
    readonly send: (token: string, notification: PushNotification) => Promise<ApnsVerdict>;
}

// Apple wants provider tokens between 20 and 60 minutes old; re-signing each send would be rejected as too
// frequent. 50 minutes leaves margin on both edges.
const JWT_LIFETIME_MS = 50 * 60_000;

// A send must never hold a daemon's fan-out longer than the daemon's own relay timeout (10s) — after that the
// daemon has already logged a transient and moved on, and the answer is wasted breath.
const REQUEST_TIMEOUT_MS = 8_000;

// The reasons Apple gives for "this token will never work again". Everything else it says about a request —
// bad payload, bad credential, throttling — is our problem or a passing one, not the device's.
const DEAD_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

// Env vars often carry the .p8 with literal "\n" — normalize so both paste styles load.
const pem = (raw: string): string => raw.replace(/\\n/g, "\n");

const base64url = (data: string): string => Buffer.from(data).toString("base64url");

/* The provider token, signed with node:crypto rather than a JWT library: Apple's is the simplest possible JWT
 * (two claims, one header), and `dsaEncoding: "ieee-p1363"` gives exactly the raw r‖s signature JOSE requires
 * — the one detail that usually justifies pulling a dependency in. */
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

    /* One HTTP/2 session per send. Notifications are rare (a turn finishing, an agent blocking) and Apple
     * closes idle sessions itself, so a kept-alive pool would be complexity spent keeping a mostly-dead
     * connection alive; a fresh session costs one round trip on an event that happens minutes apart. */
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
                // Match the web-push transport's TTL: a notification about attention wanted NOW is stale in
                // ten minutes, and delivering it hours later would be worse than dropping it.
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
        /* The daemon's shape, translated rather than reinterpreted: title/body render as the alert, `tag`
         * becomes both the collapse id (a second "waiting on you" for the same conversation REPLACES the
         * first, exactly as it does in the service worker) and the thread id (the same conversations group in
         * notification center). `url` rides in custom data for the shell's tap handler; `requireInteraction`
         * has no APNs equivalent — iOS notifications persist in notification center regardless. */
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
