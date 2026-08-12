import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/* A thin typed client for the Stripe operations the creator pool needs — money IN (checkout, portal, one
 * subscription read), money OUT (a creator's connected account, its hosted onboarding, its payout readiness),
 * and webhook signature verification. Hand-rolled over fetch rather than the Stripe SDK, the stripe-api.ts
 * precedent in the deploy engine: the platform's CLAUDE.md model is "as few dependencies as the job allows",
 * and the job here is a handful of endpoints with stable shapes. Injectable fetch for tests, like the trial
 * pool's upstream. */

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

const get = async (fetchFn: typeof fetch, secretKey: string, path: string): Promise<unknown> => {
    const response = await fetchFn(`${API_BASE}${path}`, {
        headers: { authorization: `Bearer ${secretKey}` },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`Stripe GET ${path} failed (HTTP ${response.status}): ${await response.text()}`);
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

/* A CREATOR'S CONNECTED ACCOUNT, as the platform needs to read it. Stripe holds the bank details, the identity
 * documents and the tax forms; what comes back here is only the three answers a payout decision and an honest
 * screen are made of.
 *
 * `payouts_enabled` is the ONLY field that may be read as permission to send money. `details_submitted`
 * separates a half-finished onboarding from a finished one, and `requirements.disabled_reason` is why a
 * finished account still cannot be paid — without it the creator sees a silent "not yet" and has nothing to
 * act on. Every field is optional in the parse: an account object is large and Stripe grows it, so a missing
 * one must read as "not enabled yet", never as a parse failure that breaks the screen. */
const AccountSchema = z.object({
    id: z.string(),
    payouts_enabled: z.boolean().optional(),
    details_submitted: z.boolean().optional(),
    requirements: z.object({ disabled_reason: z.string().nullable().optional() }).optional(),
});

export interface ConnectAccount {
    readonly id: string;
    readonly payoutsEnabled: boolean;
    readonly detailsSubmitted: boolean;
    // Absent when nothing is holding the account back.
    readonly disabledReason?: string;
}

const toAccount = (raw: unknown): ConnectAccount => {
    const parsed = AccountSchema.parse(raw);
    const disabledReason = parsed.requirements?.disabled_reason;
    return {
        id: parsed.id,
        payoutsEnabled: parsed.payouts_enabled ?? false,
        detailsSubmitted: parsed.details_submitted ?? false,
        ...(typeof disabledReason === `string` && disabledReason !== `` ? { disabledReason } : {}),
    };
};

// A connected account as `account.updated` carries it, or undefined for an object of some other shape — the
// webhook treats that as "not for us", exactly as it does for a subscription it cannot read.
export const accountFromEvent = (raw: unknown): ConnectAccount | undefined => (AccountSchema.safeParse(raw).success ? toAccount(raw) : undefined);

/* WHAT ACTUALLY SETTLED IN A MONTH, from the one place that knows. The live ledger states revenue as members ×
 * price, which is the right estimate for a month in progress and the wrong number to publish as fact: it
 * counts a member whose card failed on the 3rd, misses a mid-month joiner's proration, and can never be
 * reconciled against a bank account.
 *
 * Balance transactions are the honest read because they are what moved money: a charge adds, a refund
 * subtracts, a dispute adjusts, and every one of them carries the fee Stripe took. Payout and transfer rows are
 * excluded on purpose — those are money leaving for the platform's own bank or a creator's, not revenue, and
 * summing them would net the month down to roughly nothing. */
const COUNTED_TYPES = new Set([`charge`, `payment`, `refund`, `payment_refund`, `adjustment`]);

const BalancePageSchema = z.object({
    has_more: z.boolean(),
    data: z.array(z.object({ id: z.string(), type: z.string(), amount: z.number(), fee: z.number() })),
});

export interface SettledRevenue {
    // Gross movement in the window, refunds and disputes already netted out.
    readonly grossCents: number;
    // What Stripe took on it.
    readonly feeCents: number;
}

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
    /* A creator's connected account, requesting only the `transfers` capability: the platform sends money to
     * this account and never charges through it, and asking for less is what keeps the creator's onboarding to
     * the questions their own payouts actually require. Express, so Stripe hosts the identity, bank and tax
     * collection — the platform stores an id and three booleans, and never sees the rest. */
    readonly createAccount: (opts: { readonly email: string }) => Promise<ConnectAccount>;
    /* The hosted onboarding URL. Single-use and short-lived by Stripe's design, so it is minted per visit and
     * never stored; `refreshUrl` is where Stripe sends a claimant whose link went stale (straight back to mint
     * another), `returnUrl` where it sends them when they are done. */
    readonly accountLink: (opts: { readonly accountId: string; readonly refreshUrl: string; readonly returnUrl: string }) => Promise<{ url: string }>;
    // One connected account, read fresh — what an unfinished onboarding is re-checked against.
    readonly account: (id: string) => Promise<ConnectAccount>;
    // What settled between two instants, paged to the end — the revenue figure a closed month publishes.
    readonly settledRevenue: (opts: { readonly from: Date; readonly to: Date }) => Promise<SettledRevenue>;
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
    subscription: async (id) => toSubscription(await get(fetchFn, secretKey, `/subscriptions/${id}`), now),
    createAccount: async ({ email }) =>
        toAccount(
            await post(fetchFn, secretKey, `/accounts`, {
                type: `express`,
                email,
                "capabilities[transfers][requested]": `true`,
            }),
        ),
    accountLink: async ({ accountId, refreshUrl, returnUrl }) =>
        SessionSchema.parse(
            await post(fetchFn, secretKey, `/account_links`, {
                account: accountId,
                refresh_url: refreshUrl,
                return_url: returnUrl,
                type: `account_onboarding`,
            }),
        ),
    account: async (id) => toAccount(await get(fetchFn, secretKey, `/accounts/${id}`)),
    settledRevenue: async ({ from, to }) => {
        const seconds = (at: Date) => String(Math.floor(at.getTime() / 1000));
        let grossCents = 0;
        let feeCents = 0;
        let startingAfter: string | undefined;
        /* Paged to the very end rather than capped: a month of memberships is more rows than one page holds,
         * and a truncated sum published as "what we took" would be a quietly wrong number on the one page whose
         * entire purpose is being checkable. `starting_after` walks Stripe's cursor; the loop ends when it says
         * there is no more. */
        do {
            const query = new URLSearchParams({
                "created[gte]": seconds(from),
                "created[lt]": seconds(to),
                limit: `100`,
                ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
            });
            const page = BalancePageSchema.parse(await get(fetchFn, secretKey, `/balance_transactions?${query.toString()}`));
            for (const entry of page.data) {
                if (!COUNTED_TYPES.has(entry.type)) {
                    continue;
                }
                grossCents += entry.amount;
                feeCents += entry.fee;
            }
            startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
        } while (startingAfter !== undefined);
        return { grossCents, feeCents };
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
