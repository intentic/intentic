import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/* A thin typed client for the Stripe operations the hosted plan needs: a subscription checkout, the billing
 * portal, one subscription read, a cancel, a quantity change, and webhook signature verification. Hand-rolled
 * over fetch rather than the Stripe SDK, the stripe-api.ts precedent in the deploy engine: the platform's
 * CLAUDE.md model is "as few dependencies as the job allows", and the job here is six endpoints with stable
 * shapes. Injectable fetch for tests, like the trial pool's upstream. */

const API_BASE = `https://api.stripe.com/v1`;

/* WHY A REFUSAL HAPPENED, NOT MERELY THAT ONE DID. Every non-2xx from Stripe carries `{ error: { message } }`,
 * and that message is written for a person to act on; a dump of the response body names nothing. */
class StripeError extends Error {}

const RefusalSchema = z.object({ error: z.object({ message: z.string() }) });

const refusal = async (call: string, response: Response): Promise<StripeError> => {
    const body = await response.text();
    let said: string | undefined;
    try {
        said = RefusalSchema.parse(JSON.parse(body)).error.message;
    } catch {
        // Not Stripe's envelope, a proxy's HTML error page, a truncated body. Keep the raw evidence instead.
        said = undefined;
    }
    return new StripeError(said !== undefined ? `Stripe refused: ${said}` : `Stripe ${call} failed (HTTP ${response.status}): ${body}`);
};

// Stripe's request encoding is application/x-www-form-urlencoded with bracketed nesting; the plan only ever
// needs one level of it, spelled literally at the call sites below.
const send = async (fetchFn: typeof fetch, secretKey: string, method: `POST` | `DELETE`, path: string, params: Record<string, string>): Promise<unknown> => {
    const response = await fetchFn(`${API_BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${secretKey}`, "content-type": `application/x-www-form-urlencoded` },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw await refusal(`${method} ${path}`, response);
    }
    return response.json();
};

const post = (fetchFn: typeof fetch, secretKey: string, path: string, params: Record<string, string>): Promise<unknown> =>
    send(fetchFn, secretKey, `POST`, path, params);

const get = async (fetchFn: typeof fetch, secretKey: string, path: string): Promise<unknown> => {
    const response = await fetchFn(`${API_BASE}${path}`, {
        headers: { authorization: `Bearer ${secretKey}` },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw await refusal(`GET ${path}`, response);
    }
    return response.json();
};

const SessionSchema = z.object({ url: z.url() });

/* The subscription fields the plan mirror needs. `current_period_end` sits top-level on older API versions
 * and on the items on newer ones, read both, prefer the top. A subscription somehow carrying neither still
 * parses; the caller falls back to "now", which under-promises rather than inventing a date.
 *
 * `cancel_at_period_end` is what the portal's cancel sets while `status` stays active; without it the mirror
 * told people who had just cancelled that they would renew. The first item's id and quantity are the slot
 * count and the handle a slot change is addressed to (docs/design/billing-view.md). */
const SubscriptionSchema = z.object({
    id: z.string(),
    customer: z.string(),
    status: z.string(),
    cancel_at_period_end: z.boolean().optional(),
    current_period_end: z.number().optional(),
    items: z
        .object({
            data: z.array(z.object({ id: z.string().optional(), quantity: z.number().int().optional(), current_period_end: z.number().optional() })),
        })
        .optional(),
});

export interface StripeSubscription {
    readonly id: string;
    readonly customer: string;
    readonly status: string;
    readonly currentPeriodEnd: Date;
    readonly cancelAtPeriodEnd: boolean;
    // The one subscription item, empty when Stripe's answer carried none (a webhook's trimmed object).
    readonly itemId: string;
    // How many hosted sandboxes the plan covers. A subscription without a readable quantity is one slot.
    readonly quantity: number;
}

const toSubscription = (raw: unknown, now: () => Date): StripeSubscription => {
    const parsed = SubscriptionSchema.parse(raw);
    const item = parsed.items?.data[0];
    const periodEnd = parsed.current_period_end ?? item?.current_period_end;
    return {
        id: parsed.id,
        customer: parsed.customer,
        status: parsed.status,
        currentPeriodEnd: periodEnd !== undefined ? new Date(periodEnd * 1000) : now(),
        cancelAtPeriodEnd: parsed.cancel_at_period_end ?? false,
        itemId: item?.id ?? ``,
        quantity: item?.quantity ?? 1,
    };
};

// A subscription as a webhook event carries it (data.object), or undefined for an object of some other
// shape, the webhook route treats that as "not for us" rather than an error.
export const subscriptionFromEvent = (raw: unknown, now: () => Date = () => new Date()): StripeSubscription | undefined =>
    SubscriptionSchema.safeParse(raw).success ? toSubscription(raw, now) : undefined;

export interface StripeGateway {
    /* A subscription-mode Checkout Session; the answer is the URL to send the browser to.
     * `clientReferenceId` is the platform's user id, it comes back on checkout.session.completed and is the
     * only join between a Stripe customer and a platform account. `customer` is the account's existing Stripe
     * customer when it has one (a resubscriber), so one person is one customer with one invoice history
     * rather than a new customer per checkout. */
    readonly checkoutSession: (opts: {
        readonly priceId: string;
        readonly clientReferenceId: string;
        readonly customerEmail: string;
        readonly customer?: string;
        readonly successUrl: string;
        readonly cancelUrl: string;
    }) => Promise<{ url: string }>;
    // A Billing Portal session for an existing customer, where cancel/payment-method changes happen, so the
    // platform never grows its own subscription-management UI.
    readonly portalSession: (customerId: string, returnUrl: string) => Promise<{ url: string }>;
    // One subscription, read fresh, the webhook handler pulls this after checkout completes.
    readonly subscription: (id: string) => Promise<StripeSubscription>;
    // Cancel at once, the account is being deleted and there is nobody left to bill. Stripe answers the
    // subscription in its final state.
    readonly cancelSubscription: (id: string) => Promise<StripeSubscription>;
    // Set the one item's quantity (the slot count) with Stripe's default proration, so a slot added mid-month
    // costs the rest of the month and a slot removed credits it. Answers the subscription as it now stands.
    readonly setQuantity: (id: string, itemId: string, quantity: number) => Promise<StripeSubscription>;
}

export const stripeGateway = (secretKey: string, fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): StripeGateway => ({
    checkoutSession: async ({ priceId, clientReferenceId, customerEmail, customer, successUrl, cancelUrl }) =>
        SessionSchema.parse(
            await post(fetchFn, secretKey, `/checkout/sessions`, {
                mode: `subscription`,
                "line_items[0][price]": priceId,
                "line_items[0][quantity]": `1`,
                client_reference_id: clientReferenceId,
                // Stripe refuses both at once: an existing customer is addressed by id, a new one by email.
                ...(customer === undefined ? { customer_email: customerEmail } : { customer }),
                success_url: successUrl,
                cancel_url: cancelUrl,
            }),
        ),
    portalSession: async (customerId, returnUrl) =>
        SessionSchema.parse(await post(fetchFn, secretKey, `/billing_portal/sessions`, { customer: customerId, return_url: returnUrl })),
    subscription: async (id) => toSubscription(await get(fetchFn, secretKey, `/subscriptions/${id}`), now),
    cancelSubscription: async (id) => toSubscription(await send(fetchFn, secretKey, `DELETE`, `/subscriptions/${encodeURIComponent(id)}`, {}), now),
    setQuantity: async (id, itemId, quantity) =>
        toSubscription(
            await post(fetchFn, secretKey, `/subscriptions/${encodeURIComponent(id)}`, {
                "items[0][id]": itemId,
                "items[0][quantity]": String(quantity),
                proration_behavior: `create_prorations`,
            }),
            now,
        ),
});

// How far a webhook's timestamp may sit from now. Stripe's own recommended replay window.
const SIGNATURE_TOLERANCE_S = 300;

// The header's `k=v` pairs, several values per key (secret rotation puts two v1 entries on one header).
const parseSignatureHeader = (header: string): Map<string, string[]> => {
    const parts = new Map<string, string[]>();
    for (const piece of header.split(`,`)) {
        const [key, value] = piece.split(`=`, 2);
        if (key !== undefined && value !== undefined) {
            parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
        }
    }
    return parts;
};

const sameDigest = (candidate: string, expected: string): boolean => {
    const a = Buffer.from(candidate, `utf8`);
    const b = Buffer.from(expected, `utf8`);
    return a.length === b.length && timingSafeEqual(a, b);
};

/* Verify a Stripe-Signature header against the RAW request body: v1 = HMAC-SHA256(secret, "{t}.{payload}").
 * Several v1 entries are legal (secret rotation); any match passes. Constant-time compare, and the timestamp
 * tolerance is what makes a captured request expire instead of replaying forever. */
export const verifyStripeSignature = (payload: string, header: string | undefined, secret: string, now: () => Date = () => new Date()): boolean => {
    if (header === undefined || secret === ``) {
        return false;
    }
    const parts = parseSignatureHeader(header);
    const timestamp = Number(parts.get(`t`)?.[0]);
    if (!Number.isFinite(timestamp) || Math.abs(now().getTime() / 1000 - timestamp) > SIGNATURE_TOLERANCE_S) {
        return false;
    }
    const expected = createHmac(`sha256`, secret).update(`${timestamp}.${payload}`).digest(`hex`);
    return (parts.get(`v1`) ?? []).some((candidate) => sameDigest(candidate, expected));
};
