import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeStripe, signStripePayload, startFakeStripe } from "./stripe-fake.js";

/* THE STAND-IN'S OWN HTML PAGES, which are the half of it nothing else covers. Its API surface is driven hard
 * by the platform's hermetic tier (_platform/api/src/e2e/hosted-plan.e2e.test.ts, every merge request), which
 * points the REAL Stripe client at it; its checkout and portal pages are driven only by the browser tier
 * (_tools/e2e), which is a dev-machine tier that no CI job runs. So a page that stopped redirecting, or a Pay
 * that stopped delivering the webhook, would be discovered by a person mid-journey rather than by a suite.
 *
 * `integration` by name because it opens a real socket: the budget, not the ceremony (@intentic/testing/vitest). */

let stripe: FakeStripe | undefined;

afterEach(async () => {
    await stripe?.close();
    stripe = undefined;
});

const SECRETS = { secretKey: `sk_test_pages`, webhookSecret: `whsec_pages` };
const RETURN = `https://app.test/settings/billing`;

// Every event the stand-in delivers, with the signature header it carried, so the tests can read both.
const collecting = async (over: { checkoutWebhookDelayMs?: number } = {}) => {
    const delivered: { type: string; signature: string | null; object: Record<string, unknown> }[] = [];
    stripe = await startFakeStripe({
        ...SECRETS,
        ...over,
        webhookUrl: `https://api.test/hosted-plan/webhook`,
        deliver: async (request) => {
            const body = JSON.parse(await request.text()) as { type: string; data: { object: Record<string, unknown> } };
            delivered.push({ type: body.type, signature: request.headers.get(`stripe-signature`), object: body.data.object });
            return new Response(JSON.stringify({ received: true }), { status: 200 });
        },
    });
    return { stripe, delivered };
};

// A checkout session, minted the way the platform's client mints one (form-encoded, bearer key).
const openCheckout = async (fake: FakeStripe, over: Record<string, string> = {}): Promise<string> => {
    const response = await fetch(`${fake.url}/checkout/sessions`, {
        method: `POST`,
        headers: { authorization: `Bearer ${SECRETS.secretKey}`, "content-type": `application/x-www-form-urlencoded` },
        body: new URLSearchParams({
            mode: `subscription`,
            "line_items[0][price]": `price_1`,
            "line_items[0][quantity]": `1`,
            client_reference_id: `user-1`,
            customer_email: `buyer@example.com`,
            success_url: `${RETURN}?plan=welcome`,
            cancel_url: RETURN,
            ...over,
        }).toString(),
    });
    return ((await response.json()) as { url: string }).url;
};

describe(`the Stripe stand-in's checkout page`, () => {
    it(`offers Pay and Back, and sends the browser to the success URL before the webhook lands`, async () => {
        // A delay, because the ORDER is the point: production returns the browser first and the webhook after,
        // which is the gap the Billing page's polling exists for.
        const { stripe: fake, delivered } = await collecting({ checkoutWebhookDelayMs: 150 });
        const url = await openCheckout(fake);

        const page = await fetch(url);
        expect(page.status).toBe(200);
        expect(page.headers.get(`content-type`)).toContain(`text/html`);
        const html = await page.text();
        expect(html).toContain(`Fake Stripe checkout`);
        expect(html).toContain(`<form method="post" action="/checkout/${url.split(`/`).pop() ?? ``}/pay"`);

        const paid = await fetch(`${url}/pay`, { method: `POST`, redirect: `manual` });
        expect(paid.status).toBe(303);
        expect(paid.headers.get(`location`)).toBe(`${RETURN}?plan=welcome`);
        // The browser is home and nothing has been mirrored yet: exactly the state the page polls through.
        expect(delivered).toEqual([]);

        await expect.poll(() => delivered.length, { timeout: 5_000 }).toBe(1);
        expect(delivered[0]).toMatchObject({
            type: `checkout.session.completed`,
            object: { mode: `subscription`, client_reference_id: `user-1`, subscription: expect.stringMatching(/^sub_/) },
        });
        // Signed with the webhook secret, in Stripe's header shape, over the exact payload delivered.
        expect(delivered[0]?.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    });

    it(`abandons the session on Back: the browser goes to the cancel URL and nothing is created`, async () => {
        const { stripe: fake, delivered } = await collecting();
        const url = await openCheckout(fake);

        const back = await fetch(`${url}/cancel`, { method: `POST`, redirect: `manual` });
        expect(back.status).toBe(303);
        expect(back.headers.get(`location`)).toBe(RETURN);
        expect(delivered).toEqual([]);
        expect(fake.subscriptions.size).toBe(0);
        expect(fake.customers.size).toBe(0);
    });

    it(`404s a checkout session that does not exist`, async () => {
        const { stripe: fake } = await collecting();
        expect((await fetch(`${fake.origin}/checkout/cs_test_nothing`)).status).toBe(404);
    });
});

describe(`the Stripe stand-in's billing portal`, () => {
    // A customer with a live subscription, reached the way a buyer reaches one.
    const subscribed = async () => {
        const { stripe: fake, delivered } = await collecting();
        const url = await openCheckout(fake);
        await fetch(`${url}/pay`, { method: `POST`, redirect: `manual` });
        await expect.poll(() => delivered.length).toBe(1);
        const customerId = [...fake.customers.keys()][0] ?? ``;
        return { fake, delivered, customerId };
    };

    it(`cancels at period end, the way Stripe's portal does: still active, and saying it will end`, async () => {
        const { fake, delivered, customerId } = await subscribed();
        const portal = `${fake.origin}/portal/${customerId}?return_url=${encodeURIComponent(RETURN)}`;

        const page = await fetch(portal);
        expect(await page.text()).toContain(`Cancel plan`);

        const cancelled = await fetch(`${fake.origin}/portal/${customerId}/cancel?return_url=${encodeURIComponent(RETURN)}`, {
            method: `POST`,
            redirect: `manual`,
        });
        expect(cancelled.status).toBe(303);
        expect(cancelled.headers.get(`location`)).toBe(RETURN);

        // The subscription is STILL ACTIVE and says it will end: the distinction the Billing page turns into
        // "ends" rather than "renews", and the one a mirror that only read `status` used to get wrong.
        const subscription = [...fake.subscriptions.values()][0];
        expect(subscription).toMatchObject({ status: `active`, cancel_at_period_end: true });
        expect(delivered.at(-1)).toMatchObject({ type: `customer.subscription.updated`, object: { status: `active`, cancel_at_period_end: true } });

        // And the page now offers the way back, which is what a reader who changed their mind needs.
        expect(await (await fetch(portal)).text()).toContain(`Resume plan`);
    });

    it(`404s a customer it has never seen`, async () => {
        const { stripe: fake } = await collecting();
        expect((await fetch(`${fake.origin}/portal/cus_nobody`)).status).toBe(404);
    });
});

describe(`the Stripe stand-in's test door`, () => {
    it(`reports its world and drives a subscription for a driver in another process`, async () => {
        const { stripe: fake, delivered } = await collecting();
        const url = await openCheckout(fake);
        await fetch(`${url}/pay`, { method: `POST`, redirect: `manual` });
        await expect.poll(() => delivered.length).toBe(1);
        const subscriptionId = [...fake.subscriptions.keys()][0] ?? ``;

        const state = (await (await fetch(`${fake.origin}/__test/state`)).json()) as {
            subscriptions: { id: string; status: string }[];
            calls: { method: string; path: string; authorized: boolean }[];
        };
        expect(state.subscriptions).toEqual([expect.objectContaining({ id: subscriptionId, status: `active` })]);
        expect(state.calls).toEqual([expect.objectContaining({ method: `POST`, path: `/checkout/sessions`, authorized: true })]);

        // The browser tier's way to fail a charge: a patch, delivered as the event Stripe would send.
        const updated = await fetch(`${fake.origin}/__test/update/${subscriptionId}`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ patch: { status: `past_due` } }),
        });
        expect(updated.status).toBe(200);
        expect(delivered.at(-1)).toMatchObject({ type: `customer.subscription.updated`, object: { status: `past_due` } });

        // A cancel is the OTHER event type, which is what the webhook route branches on.
        await fetch(`${fake.origin}/__test/update/${subscriptionId}`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ patch: { status: `canceled` } }),
        });
        expect(delivered.at(-1)).toMatchObject({ type: `customer.subscription.deleted`, object: { status: `canceled` } });
    });
});

describe(`the Stripe stand-in's API`, () => {
    it(`refuses a call carrying the wrong key, in Stripe's own envelope, and logs it as unauthorized`, async () => {
        const { stripe: fake } = await collecting();
        const response = await fetch(`${fake.url}/checkout/sessions`, {
            method: `POST`,
            headers: { authorization: `Bearer sk_test_somebody_else`, "content-type": `application/x-www-form-urlencoded` },
            body: `mode=subscription`,
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: { type: `invalid_request_error`, message: expect.stringContaining(`Invalid API Key`) } });
        expect(fake.calls.at(-1)).toMatchObject({ path: `/checkout/sessions`, authorized: false });
    });

    it(`refuses a checkout naming both a customer and an email, exactly as Stripe does`, async () => {
        const { stripe: fake } = await collecting();
        const response = await fetch(`${fake.url}/checkout/sessions`, {
            method: `POST`,
            headers: { authorization: `Bearer ${SECRETS.secretKey}`, "content-type": `application/x-www-form-urlencoded` },
            body: new URLSearchParams({
                mode: `subscription`,
                "line_items[0][price]": `price_1`,
                client_reference_id: `user-1`,
                customer: `cus_1`,
                customer_email: `buyer@example.com`,
                success_url: RETURN,
                cancel_url: RETURN,
            }).toString(),
        });
        expect(response.status).toBe(400);
        expect((await response.json()) as { error: { message: string } }).toMatchObject({
            error: { message: expect.stringContaining(`only specify one of these parameters`) },
        });
    });
});

/* The signature the platform verifies, computed the way Stripe documents it. It is the shared premise of the
 * stand-in's every delivery and of `verifyStripeSignature` on the other side, so what is pinned is the RECIPE
 * rather than a digest: the expectation below spells out Stripe's rule (HMAC-SHA256 of the secret over
 * "<timestamp>.<payload>", the timestamp in whole seconds) from node:crypto, so a change to the separator, the
 * order, the units or the hash fails here instead of at a live endpoint. A transcribed hex string would pin
 * one input and say nothing about the rule. */
describe(`Stripe's webhook signature`, () => {
    it(`is HMAC-SHA256 over "<timestamp>.<payload>", stated as t= and v1=`, () => {
        const payload = `{"id":"evt_1","type":"customer.subscription.updated"}`;
        const secret = `whsec_fixed`;
        const at = new Date(`2026-09-07T12:34:56.789Z`);
        const timestamp = Math.floor(at.getTime() / 1000);

        const expected = createHmac(`sha256`, secret).update(`${timestamp}.${payload}`).digest(`hex`);
        expect(signStripePayload(payload, secret, at)).toBe(`t=${timestamp},v1=${expected}`);

        // Whole seconds, so the milliseconds above are dropped rather than carried into the signed string.
        expect(signStripePayload(payload, secret, at)).toBe(signStripePayload(payload, secret, new Date(`2026-09-07T12:34:56.000Z`)));
        // And the payload is signed, not merely accompanied: one byte different is a different signature.
        expect(signStripePayload(`${payload} `, secret, at)).not.toBe(signStripePayload(payload, secret, at));
    });
});
