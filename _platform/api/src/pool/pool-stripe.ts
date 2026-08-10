import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/* A thin typed client for the four Stripe operations the creator pool needs — checkout, portal, one
 * subscription read, and webhook signature verification. Hand-rolled over fetch rather than the Stripe SDK,
 * the stripe-api.ts precedent in the deploy engine: the platform's CLAUDE.md model is "as few dependencies as
 * the job allows", and the job here is four endpoints with stable shapes. Injectable fetch for tests, like
 * the trial pool's upstream. */

const API_BASE = `https://api.stripe.com/v1`;

// Stripe's request encoding is application/x-www-form-urlencoded with bracketed nesting; the pool only ever
// needs one level of it, spelled literally at the call sites below.
const post = async (fetchFn: typeof fetch, secretKey: string, path: string, params: Record<string, string>): Promise<unknown> => {
    const response = await fetchFn(`${API_BASE}${path}`, {
        method: `POST`,
        headers: { authorization: `Bearer ${secretKey}`, "content-type": `application/x-www-form-urlencoded` },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`Stripe POST ${path} failed (HTTP ${response.status}): ${await response.text()}`);
    }
    return response.json();
};

const SessionSchema = z.object({ url: z.url() });

/* The subscription fields the membership mirror needs. `current_period_end` sits top-level on older API
 * versions and on the items on newer ones — read both, prefer the top. A subscription somehow carrying
 * neither still parses; the caller falls back to "now", which under-promises rather than inventing a date. */
const SubscriptionSchema = z.object({
    id: z.string(),
    customer: z.string(),
    status: z.string(),
    current_period_end: z.number().optional(),
    items: z
        .object({ data: z.array(z.object({ current_period_end: z.number().optional() })) })
        .optional(),
});

export interface StripeSubscription {
    readonly id: string;
    readonly customer: string;
    readonly status: string;
    readonly currentPeriodEnd: Date;
}

const toSubscription = (raw: unknown, now: () => Date): StripeSubscription => {
    const parsed = SubscriptionSchema.parse(raw);
    const periodEnd = parsed.current_period_end ?? parsed.items?.data[0]?.current_period_end;
    return {
        id: parsed.id,
        customer: parsed.customer,
        status: parsed.status,
        currentPeriodEnd: periodEnd !== undefined ? new Date(periodEnd * 1000) : now(),
    };
};

// A subscription as a webhook event carries it (data.object), or undefined for an object of some other
// shape — the webhook route treats that as "not for us" rather than an error.
export const subscriptionFromEvent = (raw: unknown, now: () => Date = () => new Date()): StripeSubscription | undefined =>
    SubscriptionSchema.safeParse(raw).success ? toSubscription(raw, now) : undefined;

export interface StripeGateway {
    // A subscription-mode Checkout Session; the answer is the URL to send the browser to.
    // `clientReferenceId` is the platform's user id — it comes back on checkout.session.completed and is the
    // only join between a Stripe customer and a platform account.
    readonly checkoutSession: (opts: {
        readonly priceId: string;
        readonly clientReferenceId: string;
        readonly customerEmail: string;
        readonly successUrl: string;
        readonly cancelUrl: string;
    }) => Promise<{ url: string }>;
    // A Billing Portal session for an existing customer — where cancel/payment-method changes happen, so the
    // platform never grows its own subscription-management UI.
    readonly portalSession: (customerId: string, returnUrl: string) => Promise<{ url: string }>;
    // One subscription, read fresh — the webhook handler pulls this after checkout completes.
    readonly subscription: (id: string) => Promise<StripeSubscription>;
}

export const stripeGateway = (secretKey: string, fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): StripeGateway => ({
    checkoutSession: async ({ priceId, clientReferenceId, customerEmail, successUrl, cancelUrl }) =>
        SessionSchema.parse(
            await post(fetchFn, secretKey, `/checkout/sessions`, {
                mode: `subscription`,
                "line_items[0][price]": priceId,
                "line_items[0][quantity]": `1`,
                client_reference_id: clientReferenceId,
                customer_email: customerEmail,
                success_url: successUrl,
                cancel_url: cancelUrl,
            }),
        ),
    portalSession: async (customerId, returnUrl) =>
        SessionSchema.parse(await post(fetchFn, secretKey, `/billing_portal/sessions`, { customer: customerId, return_url: returnUrl })),
    subscription: async (id) => {
        const response = await fetchFn(`${API_BASE}/subscriptions/${id}`, {
            headers: { authorization: `Bearer ${secretKey}` },
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(`Stripe GET /subscriptions failed (HTTP ${response.status}): ${await response.text()}`);
        }
        return toSubscription(await response.json(), now);
    },
});

// How far a webhook's timestamp may sit from now — Stripe's own recommended replay window.
const SIGNATURE_TOLERANCE_S = 300;

/* Verify a Stripe-Signature header against the RAW request body: v1 = HMAC-SHA256(secret, "{t}.{payload}").
 * Several v1 entries are legal (secret rotation); any match passes. Constant-time compare, and the timestamp
 * tolerance is what makes a captured request expire instead of replaying forever. */
export const verifyStripeSignature = (payload: string, header: string | undefined, secret: string, now: () => Date = () => new Date()): boolean => {
    if (header === undefined || secret === ``) {
        return false;
    }
    const parts = new Map<string, string[]>();
    for (const piece of header.split(`,`)) {
        const [key, value] = piece.split(`=`, 2);
        if (key !== undefined && value !== undefined) {
            parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
        }
    }
    const timestamp = Number(parts.get(`t`)?.[0]);
    if (!Number.isFinite(timestamp) || Math.abs(now().getTime() / 1000 - timestamp) > SIGNATURE_TOLERANCE_S) {
        return false;
    }
    const expected = createHmac(`sha256`, secret).update(`${timestamp}.${payload}`).digest(`hex`);
    return (parts.get(`v1`) ?? []).some((candidate) => {
        const a = Buffer.from(candidate, `utf8`);
        const b = Buffer.from(expected, `utf8`);
        return a.length === b.length && timingSafeEqual(a, b);
    });
};
