import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookSignatureScheme } from "@intentic/sandbox-contract/schemas/automations";
import { parseJsonOr } from "@intentic/base/json";
import { z } from "zod";

// A signed webhook's proof, checked the way each provider signs: an HMAC-SHA256 over the raw body (and, for the
// timestamped schemes, the moment it was sent), compared in constant time. A timestamped scheme also refuses a
// delivery older than TOLERANCE_MS, so a captured call cannot be replayed later. What the provider calls the delivery
// is read here too, so a redelivery of a call already taken is recognised (fire.routes.ts, delivery-ledger.ts).

// Five minutes either way: Stripe's and Standard Webhooks' own default tolerance.
export const TOLERANCE_MS = 5 * 60_000;

export type SignatureCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: SignatureCheck = { ok: true };
const refused = (reason: string): SignatureCheck => ({ ok: false, reason });

const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

// Constant-time over the decoded bytes; a value that does not decode to the digest's length is simply unequal.
const digestEquals = (expected: Buffer, presented: string, encoding: "hex" | "base64"): boolean => {
    const valid = encoding === "hex" ? /^[0-9a-f]+$/i.test(presented) : /^[A-Za-z0-9+/]+=*$/.test(presented);
    if (!valid) {
        return false;
    }
    const bytes = Buffer.from(presented, encoding);
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
};

const fresh = (sentMs: number, now: number): boolean => Number.isFinite(sentMs) && Math.abs(now - sentMs) <= TOLERANCE_MS;

const github = (secret: string, headers: Headers, body: string): SignatureCheck => {
    const header = headers.get("x-hub-signature-256");
    if (header === null) {
        return refused("missing X-Hub-Signature-256");
    }
    const presented = header.startsWith("sha256=") ? header.slice("sha256=".length) : "";
    return digestEquals(hmac(secret, body), presented, "hex") ? OK : refused("bad signature");
};

const LinearBodySchema = z.looseObject({ webhookTimestamp: z.number().optional() });
const BodyIdSchema = z.looseObject({ id: z.string().min(1).optional() });

// Linear signs the body alone and puts the moment it sent into the body (`webhookTimestamp`, milliseconds).
const linear = (secret: string, headers: Headers, body: string, now: number): SignatureCheck => {
    const header = headers.get("linear-signature");
    if (header === null) {
        return refused("missing Linear-Signature");
    }
    if (!digestEquals(hmac(secret, body), header.trim(), "hex")) {
        return refused("bad signature");
    }
    const sent = LinearBodySchema.safeParse(parseJsonOr(body, undefined)).data?.webhookTimestamp;
    return sent !== undefined && !fresh(sent, now) ? refused("stale delivery") : OK;
};

// Sentry signs the body; its `Sentry-Hook-Timestamp` (seconds) is checked when sent.
const sentry = (secret: string, headers: Headers, body: string, now: number): SignatureCheck => {
    const header = headers.get("sentry-hook-signature");
    if (header === null) {
        return refused("missing Sentry-Hook-Signature");
    }
    if (!digestEquals(hmac(secret, body), header.trim(), "hex")) {
        return refused("bad signature");
    }
    const sent = headers.get("sentry-hook-timestamp");
    return sent !== null && !fresh(Number(sent) * 1000, now) ? refused("stale delivery") : OK;
};

// `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>…]` over `<t>.<body>`; any v1 matching passes (a secret rolling).
const stripe = (secret: string, headers: Headers, body: string, now: number): SignatureCheck => {
    const header = headers.get("stripe-signature");
    if (header === null) {
        return refused("missing Stripe-Signature");
    }
    const parts = header.split(",").map((part) => {
        const at = part.indexOf("=");
        return { key: part.slice(0, Math.max(at, 0)).trim(), value: part.slice(at + 1).trim() };
    });
    const t = parts.find((part) => part.key === "t")?.value;
    const signatures = parts.filter((part) => part.key === "v1").map((part) => part.value);
    if (t === undefined || !/^\d+$/.test(t) || signatures.length === 0) {
        return refused("malformed Stripe-Signature");
    }
    const expected = hmac(secret, `${t}.${body}`);
    if (!signatures.some((presented) => digestEquals(expected, presented, "hex"))) {
        return refused("bad signature");
    }
    return fresh(Number(t) * 1000, now) ? OK : refused("stale delivery");
};

// Standard Webhooks: `webhook-signature: v1,<base64> [v1,<base64>…]` over `<id>.<timestamp>.<body>`, keyed with the
// base64 secret after its `whsec_` prefix.
const standard = (secret: string, headers: Headers, body: string, now: number): SignatureCheck => {
    const id = headers.get("webhook-id");
    const timestamp = headers.get("webhook-timestamp");
    const header = headers.get("webhook-signature");
    if (id === null || timestamp === null || header === null) {
        return refused("missing webhook-id, webhook-timestamp or webhook-signature");
    }
    if (!/^\d+$/.test(timestamp)) {
        return refused("malformed webhook-timestamp");
    }
    const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
    const expected = hmac(key, `${id}.${timestamp}.${body}`);
    const signatures = header
        .split(" ")
        .map((entry) => entry.split(",", 2))
        .filter(([version]) => version === "v1")
        .map(([, value]) => value ?? "");
    if (!signatures.some((presented) => digestEquals(expected, presented, "base64"))) {
        return refused("bad signature");
    }
    return fresh(Number(timestamp) * 1000, now) ? OK : refused("stale delivery");
};

/** Whether `body` arrived signed with `secret` under `scheme`, and recently enough where the scheme says when. */
export const verifyWebhookSignature = (scheme: WebhookSignatureScheme, secret: string, headers: Headers, body: string, now: number): SignatureCheck => {
    switch (scheme) {
        case "github":
            return github(secret, headers, body);
        case "linear":
            return linear(secret, headers, body, now);
        case "sentry":
            return sentry(secret, headers, body, now);
        case "stripe":
            return stripe(secret, headers, body, now);
        case "standard-webhooks":
            return standard(secret, headers, body, now);
    }
};

const bodyId = (body: string): string | undefined => BodyIdSchema.safeParse(parseJsonOr(body, undefined)).data?.id;

/** What the provider calls this delivery, the same on every redelivery of it; undefined when it names none. */
export const deliveryIdOf = (scheme: WebhookSignatureScheme, headers: Headers, body: string): string | undefined => {
    switch (scheme) {
        case "github":
            return headers.get("x-github-delivery") ?? undefined;
        case "linear":
            return headers.get("linear-delivery") ?? undefined;
        case "sentry":
            return headers.get("request-id") ?? undefined;
        case "stripe":
            // The event's own id (evt_…), which Stripe resends unchanged.
            return bodyId(body);
        case "standard-webhooks":
            return headers.get("webhook-id") ?? undefined;
    }
};

/** A delivery that is only the provider checking the hook is there, acknowledged without waking anything. */
export const isPingDelivery = (scheme: WebhookSignatureScheme, headers: Headers): boolean => scheme === "github" && headers.get("x-github-event") === "ping";

// Keys whose values are credentials, whatever service sent them: masked before the payload is kept or shown.
const CREDENTIAL_KEY = /(secret|password|passwd|token|api[-_]?key|private[-_]?key|access[-_]?key|authorization|signature|credential)/i;
const MASK = "[redacted]";

// JSON.parse's reviver sees every key at every depth; the root's key is the empty string.
type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };
const maskCredentials = (key: string, value: JsonValue): JsonValue => (key !== "" && CREDENTIAL_KEY.test(key) ? MASK : value);

const redactedJson = (body: string): string | undefined => {
    try {
        return JSON.stringify(JSON.parse(body, maskCredentials));
    } catch {
        // allow(silent-catch): a body that is not JSON has no keys to mask; the caller masks the secret in its text
        return undefined;
    }
};

/**
 * The payload as the wake keeps it: a JSON body with every credential-named key's value masked, and the signing
 * secret itself masked wherever it appears in the text. A body that is not JSON keeps only the second.
 */
export const redactPayload = (body: string, secret: string | undefined): string => {
    const text = body.trimStart().startsWith("{") || body.trimStart().startsWith("[") ? (redactedJson(body) ?? body) : body;
    return secret === undefined || secret.length < 8 ? text : text.replaceAll(secret, MASK);
};
