import { createHmac } from "node:crypto";
import { deliveryIdOf, isPingDelivery, redactPayload, TOLERANCE_MS, verifyWebhookSignature } from "./webhook-signature.js";

const NOW = 1_800_000_000_000;
const SECRET = "it-is-a-signing-secret";
const BODY = JSON.stringify({ id: "evt_1", action: "opened", webhookTimestamp: NOW });
const hex = (key: string | Buffer, data: string): string => createHmac("sha256", key).update(data).digest("hex");
const b64 = (key: Buffer, data: string): string => createHmac("sha256", key).update(data).digest("base64");
const seconds = (ms: number): string => String(Math.floor(ms / 1000));

describe("github", () => {
    test("a body signed with the secret passes; a wrong or missing signature does not", () => {
        const signed = new Headers({ "x-hub-signature-256": `sha256=${hex(SECRET, BODY)}` });
        expect(verifyWebhookSignature("github", SECRET, signed, BODY, NOW)).toEqual({ ok: true });
        expect(verifyWebhookSignature("github", SECRET, signed, `${BODY} `, NOW).ok).toBe(false);
        expect(verifyWebhookSignature("github", "other", signed, BODY, NOW).ok).toBe(false);
        expect(verifyWebhookSignature("github", SECRET, new Headers({ "x-hub-signature-256": hex(SECRET, BODY) }), BODY, NOW).ok).toBe(false);
        expect(verifyWebhookSignature("github", SECRET, new Headers(), BODY, NOW)).toEqual({ ok: false, reason: "missing X-Hub-Signature-256" });
    });
    test("names the delivery, and a ping is only a ping", () => {
        const headers = new Headers({ "x-github-delivery": "d-1", "x-github-event": "ping" });
        expect(deliveryIdOf("github", headers, BODY)).toBe("d-1");
        expect(isPingDelivery("github", headers)).toBe(true);
        expect(isPingDelivery("github", new Headers({ "x-github-event": "push" }))).toBe(false);
    });
});

describe("linear", () => {
    test("checks the body's HMAC and refuses a stale webhookTimestamp", () => {
        const headers = new Headers({ "linear-signature": hex(SECRET, BODY), "linear-delivery": "l-1" });
        expect(verifyWebhookSignature("linear", SECRET, headers, BODY, NOW)).toEqual({ ok: true });
        expect(verifyWebhookSignature("linear", SECRET, headers, BODY, NOW + TOLERANCE_MS + 1)).toEqual({ ok: false, reason: "stale delivery" });
        expect(verifyWebhookSignature("linear", SECRET, new Headers({ "linear-signature": "00" }), BODY, NOW).ok).toBe(false);
        expect(verifyWebhookSignature("linear", SECRET, new Headers(), BODY, NOW).ok).toBe(false);
        expect(deliveryIdOf("linear", headers, BODY)).toBe("l-1");
    });
});

describe("sentry", () => {
    test("checks the body's HMAC and its timestamp header when sent", () => {
        const signature = hex(SECRET, BODY);
        expect(verifyWebhookSignature("sentry", SECRET, new Headers({ "sentry-hook-signature": signature }), BODY, NOW)).toEqual({ ok: true });
        const stale = new Headers({ "sentry-hook-signature": signature, "sentry-hook-timestamp": seconds(NOW - TOLERANCE_MS - 5_000) });
        expect(verifyWebhookSignature("sentry", SECRET, stale, BODY, NOW)).toEqual({ ok: false, reason: "stale delivery" });
        expect(verifyWebhookSignature("sentry", SECRET, new Headers({ "sentry-hook-signature": hex("x", BODY) }), BODY, NOW).ok).toBe(false);
        expect(verifyWebhookSignature("sentry", SECRET, new Headers(), BODY, NOW).ok).toBe(false);
        expect(deliveryIdOf("sentry", new Headers({ "request-id": "r-1" }), BODY)).toBe("r-1");
    });
});

describe("stripe", () => {
    const t = seconds(NOW);
    test("any v1 over `t.body` passes inside the tolerance", () => {
        const headers = new Headers({ "stripe-signature": `t=${t},v1=${hex("old", `${t}.${BODY}`)},v1=${hex(SECRET, `${t}.${BODY}`)}` });
        expect(verifyWebhookSignature("stripe", SECRET, headers, BODY, NOW)).toEqual({ ok: true });
        expect(verifyWebhookSignature("stripe", SECRET, headers, BODY, NOW + TOLERANCE_MS + 1_000)).toEqual({ ok: false, reason: "stale delivery" });
        expect(deliveryIdOf("stripe", headers, BODY)).toBe("evt_1");
    });
    test("a signature over another timestamp, a malformed header or none is refused", () => {
        const forged = new Headers({ "stripe-signature": `t=${Number(t) + 1},v1=${hex(SECRET, `${t}.${BODY}`)}` });
        expect(verifyWebhookSignature("stripe", SECRET, forged, BODY, NOW).ok).toBe(false);
        expect(verifyWebhookSignature("stripe", SECRET, new Headers({ "stripe-signature": "v1=abc" }), BODY, NOW)).toEqual({
            ok: false,
            reason: "malformed Stripe-Signature",
        });
        expect(verifyWebhookSignature("stripe", SECRET, new Headers(), BODY, NOW).ok).toBe(false);
    });
});

describe("standard-webhooks", () => {
    const key = Buffer.from("a-standard-webhooks-key-32-bytes");
    const secret = `whsec_${key.toString("base64")}`;
    const ts = seconds(NOW);
    const signed = (id: string, at: string) => new Headers({ "webhook-id": id, "webhook-timestamp": at, "webhook-signature": `v1,${b64(key, `${id}.${at}.${BODY}`)}` });
    test("v1 over `id.timestamp.body` with the whsec_ key passes", () => {
        expect(verifyWebhookSignature("standard-webhooks", secret, signed("msg_1", ts), BODY, NOW)).toEqual({ ok: true });
        expect(deliveryIdOf("standard-webhooks", signed("msg_1", ts), BODY)).toBe("msg_1");
    });
    test("a stale timestamp, a swapped id, a wrong key and missing headers are refused", () => {
        const old = seconds(NOW - TOLERANCE_MS - 10_000);
        expect(verifyWebhookSignature("standard-webhooks", secret, signed("msg_1", old), BODY, NOW)).toEqual({ ok: false, reason: "stale delivery" });
        const swapped = signed("msg_1", ts);
        swapped.set("webhook-id", "msg_2");
        expect(verifyWebhookSignature("standard-webhooks", secret, swapped, BODY, NOW).ok).toBe(false);
        expect(verifyWebhookSignature("standard-webhooks", `whsec_${Buffer.from("other").toString("base64")}`, signed("msg_1", ts), BODY, NOW).ok).toBe(false);
        expect(verifyWebhookSignature("standard-webhooks", secret, new Headers({ "webhook-id": "msg_1" }), BODY, NOW).ok).toBe(false);
    });
});

describe("redactPayload", () => {
    test("masks credential-named keys at any depth and the signing secret anywhere", () => {
        const body = JSON.stringify({ user: "ada", api_key: "k", nested: [{ password: "p", note: `has ${SECRET} inside` }], hook: { secret: "s" } });
        expect(JSON.parse(redactPayload(body, SECRET))).toEqual({
            user: "ada",
            api_key: "[redacted]",
            nested: [{ password: "[redacted]", note: "has [redacted] inside" }],
            hook: { secret: "[redacted]" },
        });
    });
    test("leaves a body that is not JSON as it was, but for the secret", () => {
        expect(redactPayload("token=abc", undefined)).toBe("token=abc");
        expect(redactPayload(`x ${SECRET}`, SECRET)).toBe("x [redacted]");
    });
});
