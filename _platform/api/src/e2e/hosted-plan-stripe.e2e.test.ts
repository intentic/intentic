import { e2eTier } from "@intentic/testing/e2e";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StripeClientConfig, type StripeGateway, stripeGateway, subscriptionIdOfEvent } from "../sandbox/hosted/hosted-plan-stripe.js";
import { DAY_MS } from "../durations.js";

/* THE STRIPE CLIENT AGAINST STRIPE. Every other test of the money path, unit or hermetic, talks to shapes WE
 * wrote down: a hand-built payload, a stand-in that answers what the client expects. This is the one that asks
 * Stripe, and it exists for the failures the others cannot see: a request the API refuses (a parameter spelled
 * wrong in the form encoding), a response whose field moved under an API version (`current_period_end` left
 * the subscription for its item in 2025-03-31.basil), an event whose object no longer parses, and a billing
 * portal that has no default configuration saved, which is a go-live step, not a bug.
 *
 * Gated on a TEST-mode key and the test-mode price of the hosted plan, and nightly rather than per merge: it
 * creates a customer with Stripe's test card, subscribes it outside checkout (a checkout needs a browser and a
 * card form; the client's checkout call is exercised up to the URL it answers), drives the client's every
 * other call against that subscription, and deletes the customer, which ends whatever it left. A live key is
 * refused before anything is created. */
const tier = e2eTier(`the Stripe client against Stripe's own test mode`, {
    enabledBy: `INTENTIC_E2E`,
    secrets: [`HOSTED_PLAN_E2E_STRIPE_SECRET_KEY`, `HOSTED_PLAN_E2E_STRIPE_PRICE_ID`],
});

const STRIPE_API_URL = `https://api.stripe.com/v1`;
const RETURN_URL = `https://example.com/settings/billing`;

interface StripeObject {
    readonly id: string;
    readonly [key: string]: unknown;
}

/* The setup calls the client itself never makes (a customer with a card, a subscription outside checkout, the
 * cleanup, the event log), in Stripe's own form encoding. Kept apart from the gateway on purpose: the gateway
 * is what is under test, and it must not grow calls for the sake of its test. */
const stripeCall = async (
    client: StripeClientConfig,
    method: `GET` | `POST` | `DELETE`,
    path: string,
    params: Record<string, string> = {},
): Promise<StripeObject> => {
    const response = await fetch(`${client.stripeApiUrl}${path}`, {
        method,
        headers: {
            authorization: `Bearer ${client.stripeSecretKey}`,
            ...(method === `POST` ? { "content-type": `application/x-www-form-urlencoded` } : {}),
        },
        ...(method === `POST` ? { body: new URLSearchParams(params).toString() } : {}),
        signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as StripeObject & { error?: { message: string } };
    if (!response.ok) {
        throw new Error(`Stripe ${method} ${path} refused: ${body.error?.message ?? response.status}`);
    }
    return body;
};

describe.skipIf(!tier.runs)(tier.title, () => {
    let client: StripeClientConfig;
    let gateway: StripeGateway;
    let priceId: string;
    let customerId: string;
    let subscriptionId: string;
    let itemId: string;

    beforeAll(async () => {
        const secretKey = tier.secrets.HOSTED_PLAN_E2E_STRIPE_SECRET_KEY;
        if (!/^(sk|rk)_test_/.test(secretKey)) {
            throw new Error(
                `HOSTED_PLAN_E2E_STRIPE_SECRET_KEY must be a TEST-mode key (sk_test_… or rk_test_…): this suite creates and cancels subscriptions`,
            );
        }
        priceId = tier.secrets.HOSTED_PLAN_E2E_STRIPE_PRICE_ID;
        client = { stripeSecretKey: secretKey, stripeApiUrl: STRIPE_API_URL };
        gateway = stripeGateway(client);

        // Stripe's always-succeeding test card, as the customer's default payment method, so the first invoice
        // is paid on creation and the subscription is born active, the state a completed checkout leaves.
        const customer = await stripeCall(client, `POST`, `/customers`, {
            email: `e2e+${Date.now()}@intentic.dev`,
            name: `intentic hosted-plan e2e`,
            payment_method: `pm_card_visa`,
            "invoice_settings[default_payment_method]": `pm_card_visa`,
        });
        customerId = customer.id;
        const subscription = await stripeCall(client, `POST`, `/subscriptions`, { customer: customerId, "items[0][price]": priceId });
        subscriptionId = subscription.id;
    });

    afterAll(async () => {
        // Deleting the customer cancels its subscriptions and is what keeps the test account clean.
        if (customerId !== undefined) {
            await stripeCall(client, `DELETE`, `/customers/${customerId}`);
        }
    });

    it(`reads a subscription in the shape the mirror needs, on this account's API version`, async () => {
        const read = await gateway.subscription(subscriptionId);
        expect(read).toMatchObject({ id: subscriptionId, customer: customerId, status: `active`, cancelAtPeriodEnd: false, quantity: 1 });
        expect(read.itemId).toMatch(/^si_/);
        itemId = read.itemId;
        // A period end Stripe actually stated, a month out, and not the client's "now" fallback for a shape
        // it could not read: the fallback is what a moved field would produce, and it under-promises quietly.
        expect(read.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 20 * DAY_MS);
    });

    it(`changes the slot count with proration and reads the new count back`, async () => {
        expect((await gateway.setQuantity(subscriptionId, itemId, 2)).quantity).toBe(2);
        expect((await gateway.subscription(subscriptionId)).quantity).toBe(2);
        expect((await gateway.setQuantity(subscriptionId, itemId, 1)).quantity).toBe(1);
    });

    it(`mints a checkout session for a new buyer and for a returning customer`, async () => {
        const ask = { priceId, clientReferenceId: `e2e-user`, successUrl: `${RETURN_URL}?plan=welcome`, cancelUrl: RETURN_URL };
        const fresh = await gateway.checkoutSession({ ...ask, customerEmail: `e2e-buyer@intentic.dev` });
        expect(fresh.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
        // The resubscriber is addressed by id: one customer, one invoice history.
        const returning = await gateway.checkoutSession({ ...ask, customerEmail: `ignored@intentic.dev`, customer: customerId });
        expect(returning.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    });

    /* A refusal here reading "No configuration provided and your test mode default configuration has not
     * been created" is the go-live step this test exists to catch: Stripe Dashboard → Settings → Billing →
     * Customer portal → Save, in test mode and in live mode both, with subscription updates OFF
     * (docs/design/billing-view.md: the app's slot rule is the only one). */
    it(`opens the billing portal for the customer`, async () => {
        const portal = await gateway.portalSession(customerId, RETURN_URL);
        expect(portal.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    });

    it(`names the subscription in the events Stripe actually emits, the way the webhook reads them`, async () => {
        // The two quantity changes above each produced a customer.subscription.updated; the event log is
        // eventually consistent, so it is asked until both are there.
        const objectsOfOurs = async (): Promise<unknown[]> => {
            const events = (await stripeCall(client, `GET`, `/events?type=customer.subscription.updated&limit=20`)) as StripeObject & {
                data: { data: { object: StripeObject } }[];
            };
            return events.data.map((event) => event.data.object).filter((object) => object.id === subscriptionId);
        };
        await expect.poll(async () => (await objectsOfOurs()).length, { timeout: 30_000, interval: 2_000 }).toBeGreaterThanOrEqual(2);
        for (const object of await objectsOfOurs()) {
            // The id is all the webhook takes off an event; the state is read fresh, which the first test covers.
            expect(subscriptionIdOfEvent(object)).toBe(subscriptionId);
        }
    });

    it(`cancels at once, as an account deletion does`, async () => {
        expect((await gateway.cancelSubscription(subscriptionId)).status).toBe(`canceled`);
        expect((await gateway.subscription(subscriptionId)).status).toBe(`canceled`);
    });
});
