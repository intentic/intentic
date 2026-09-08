import { e2eTier } from "@intentic/testing/e2e";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StripeClientConfig, type StripeGateway, stripeGateway, subscriptionIdOfEvent } from "../sandbox/hosted/hosted-plan-stripe.js";
import { DAY_MS } from "../durations.js";

// The one test that hits real Stripe: API refusals, fields moved under an API version, a missing portal config.
// Nightly, gated on a test-mode key; creates and deletes a real customer and subscription outside checkout.
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

// The setup calls the client itself never makes, in Stripe's own form encoding; kept apart so the gateway under test
// does not grow calls for its own sake.
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

        // Stripe's always-succeeding test card, as the default payment method, so the subscription is born active.
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
        // Deleting the customer cancels its subscriptions and keeps the test account clean.
        if (customerId !== undefined) {
            await stripeCall(client, `DELETE`, `/customers/${customerId}`);
        }
    });

    it(`reads a subscription in the shape the mirror needs, on this account's API version`, async () => {
        const read = await gateway.subscription(subscriptionId);
        expect(read).toMatchObject({ id: subscriptionId, customer: customerId, status: `active`, cancelAtPeriodEnd: false, quantity: 1 });
        expect(read.itemId).toMatch(/^si_/);
        itemId = read.itemId;
        // A period end Stripe actually stated, not the client's fallback for a shape it could not read.
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

    // A refusal here (no test-mode portal configuration) is the go-live step this test exists to catch.
    it(`opens the billing portal for the customer`, async () => {
        const portal = await gateway.portalSession(customerId, RETURN_URL);
        expect(portal.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    });

    it(`names the subscription in the events Stripe actually emits, the way the webhook reads them`, async () => {
        // The event log is eventually consistent, so it is polled until both quantity changes show up.
        const objectsOfOurs = async (): Promise<unknown[]> => {
            const events = (await stripeCall(client, `GET`, `/events?type=customer.subscription.updated&limit=20`)) as StripeObject & {
                data: { data: { object: StripeObject } }[];
            };
            return events.data.map((event) => event.data.object).filter((object) => object.id === subscriptionId);
        };
        await expect.poll(async () => (await objectsOfOurs()).length, { timeout: 30_000, interval: 2_000 }).toBeGreaterThanOrEqual(2);
        for (const object of await objectsOfOurs()) {
            // The id is all the webhook takes off an event; the state itself is read fresh.
            expect(subscriptionIdOfEvent(object)).toBe(subscriptionId);
        }
    });

    it(`cancels at once, as an account deletion does`, async () => {
        expect((await gateway.cancelSubscription(subscriptionId)).status).toBe(`canceled`);
        expect((await gateway.subscription(subscriptionId)).status).toBe(`canceled`);
    });
});
