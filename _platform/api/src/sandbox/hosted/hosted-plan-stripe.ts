import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Thin typed client for the six Stripe operations the hosted plan needs, hand-rolled over fetch rather than the SDK
// (fewer dependencies). The host is config (hostedPlan.stripeApiUrl), never set in production, so tests point this same
// client at a stand-in (@intentic/testing/stripe-fake) and exercise the whole money path.

// What the client needs from the plan's config: the signing key and the host to talk to.
export interface StripeClientConfig {
    readonly stripeSecretKey: string;
    readonly stripeApiUrl: string;
}

// Why a refusal happened, not just that one did: Stripe's `{ error: { message } }` is meant for a person to act on.
class StripeError extends Error {}

const RefusalSchema = z.object({ error: z.object({ message: z.string() }) });

const refusal = async (call: string, response: Response): Promise<StripeError> => {
    const body = await response.text();
    let said: string | undefined;
    try {
        said = RefusalSchema.parse(JSON.parse(body)).error.message;
    } catch {
        // Not Stripe's envelope (a proxy's HTML page, a truncated body); keep the raw evidence instead.
        said = undefined;
    }
    return new StripeError(said !== undefined ? `Stripe refused: ${said}` : `Stripe ${call} failed (HTTP ${response.status}): ${body}`);
};

// Stripe encodes requests as x-www-form-urlencoded with bracketed nesting; the plan needs only one level, spelled
// literally at each call site.
const send = async (
    fetchFn: typeof fetch,
    client: StripeClientConfig,
    method: `POST` | `DELETE`,
    path: string,
    params: Record<string, string>,
): Promise<unknown> => {
    const response = await fetchFn(`${client.stripeApiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${client.stripeSecretKey}`, "content-type": `application/x-www-form-urlencoded` },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw await refusal(`${method} ${path}`, response);
    }
    return response.json();
};

const post = (fetchFn: typeof fetch, client: StripeClientConfig, path: string, params: Record<string, string>): Promise<unknown> =>
    send(fetchFn, client, `POST`, path, params);

const get = async (fetchFn: typeof fetch, client: StripeClientConfig, path: string): Promise<unknown> => {
    const response = await fetchFn(`${client.stripeApiUrl}${path}`, {
        headers: { authorization: `Bearer ${client.stripeSecretKey}` },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw await refusal(`GET ${path}`, response);
    }
    return response.json();
};

const SessionSchema = z.object({ url: z.url() });

// current_period_end sits top-level or on the first item (top preferred; missing falls back to `now`).
// cancel_at_period_end tracks the portal's cancel; the item's id/quantity are the slot count and change target.
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
    // The one subscription item's id, empty when Stripe's answer carried none (a trimmed webhook object).
    readonly itemId: string;
    // Hosted sandboxes the plan covers; a subscription without a readable quantity is one slot.
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

// The subscription id a webhook event names; state is re-read fresh rather than trusted off the event. Undefined for
// any other object shape, read as not for us.
const EventSubscriptionSchema = z.object({ id: z.string(), object: z.literal(`subscription`) });

export const subscriptionIdOfEvent = (raw: unknown): string | undefined => {
    const parsed = EventSubscriptionSchema.safeParse(raw);
    return parsed.success ? parsed.data.id : undefined;
};

export interface StripeGateway {
    // A subscription-mode Checkout Session; answers the browser's redirect URL. clientReferenceId is the platform's
    // user id; customer addresses an existing Stripe customer for one invoice history.
    readonly checkoutSession: (opts: {
        readonly priceId: string;
        readonly clientReferenceId: string;
        readonly customerEmail: string;
        readonly customer?: string;
        readonly successUrl: string;
        readonly cancelUrl: string;
    }) => Promise<{ url: string }>;
    // Billing Portal session for an existing customer (cancel/payment-method changes), so the platform needs no
    // subscription-management UI of its own.
    readonly portalSession: (customerId: string, returnUrl: string) => Promise<{ url: string }>;
    // One subscription, read fresh; the webhook handler pulls this after checkout completes.
    readonly subscription: (id: string) => Promise<StripeSubscription>;
    // Cancels at once, for an account being deleted with nobody left to bill; answers the subscription in its final
    // state.
    readonly cancelSubscription: (id: string) => Promise<StripeSubscription>;
    // Sets the one item's quantity (slot count) with Stripe's default proration, so a mid-month change is prorated;
    // answers the subscription as it now stands.
    readonly setQuantity: (id: string, itemId: string, quantity: number) => Promise<StripeSubscription>;
}

export const stripeGateway = (client: StripeClientConfig, fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): StripeGateway => ({
    checkoutSession: async ({ priceId, clientReferenceId, customerEmail, customer, successUrl, cancelUrl }) =>
        SessionSchema.parse(
            await post(fetchFn, client, `/checkout/sessions`, {
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
        SessionSchema.parse(await post(fetchFn, client, `/billing_portal/sessions`, { customer: customerId, return_url: returnUrl })),
    subscription: async (id) => toSubscription(await get(fetchFn, client, `/subscriptions/${encodeURIComponent(id)}`), now),
    cancelSubscription: async (id) => toSubscription(await send(fetchFn, client, `DELETE`, `/subscriptions/${encodeURIComponent(id)}`, {}), now),
    setQuantity: async (id, itemId, quantity) =>
        toSubscription(
            await post(fetchFn, client, `/subscriptions/${encodeURIComponent(id)}`, {
                "items[0][id]": itemId,
                "items[0][quantity]": String(quantity),
                proration_behavior: `create_prorations`,
            }),
            now,
        ),
});

// How far a webhook's timestamp may drift from now; Stripe's own recommended replay window.
const SIGNATURE_TOLERANCE_S = 300;

// The header's k=v pairs, several values per key (secret rotation puts two v1 entries on one header).
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

// Verifies a Stripe-Signature header against the raw body: v1 = HMAC-SHA256(secret, `{t}.{payload}`); any of several v1
// entries may match. Constant-time compare; the timestamp tolerance stops a captured request from replaying forever.
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
