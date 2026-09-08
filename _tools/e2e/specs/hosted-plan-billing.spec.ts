import { expect, test } from "@playwright/test";
import { FAKE_STRIPE, readStackState } from "../stack.js";

// Billing journey against the real API and Stripe client, with @intentic/testing/stripe-fake standing in for Stripe;
// skipped unless this run booted that stand-in. Wording matters (ends vs renews) since no unit test reads the page.
test.describe.configure({ mode: `serial` });

test.beforeAll(() => {
    test.skip(readStackState().fakeStripe !== true, `the api was not booted by this run, so there is no Stripe stand-in behind it`);
});

const control = `${FAKE_STRIPE.origin}/__test`;

interface FakeState {
    subscriptions: { id: string; status: string }[];
}

test(`the offer, then a paid checkout the page turns into an active plan while the webhook is still on its way`, async ({ page }) => {
    await page.goto(`/settings/billing`);
    await expect(page.getByRole(`heading`, { name: `Keep your hosted sandbox always on.` })).toBeVisible();

    await page.getByRole(`button`, { name: `Subscribe for $20/month` }).first().click();
    // Off to Stripe: the api minted the session, the stand-in hosts the page.
    await expect(page).toHaveURL(new RegExp(`^${FAKE_STRIPE.origin}/checkout/cs_test_`));
    await expect(page.getByRole(`heading`, { name: `Fake Stripe checkout` })).toBeVisible();
    await page.getByRole(`button`, { name: `Pay` }).click();

    // Redirects home before the webhook lands; the page polls rather than requiring a reload.
    await expect(page).toHaveURL(/\/settings\/billing\?plan=welcome$/);
    await expect(page.getByText(`Payment received, activating your plan`)).toBeVisible();
    await expect(page.getByText(/Your hosted sandbox(es)? (is|are) always on/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole(`button`, { name: `Manage on Stripe` })).toBeVisible();
    await expect(page.getByText(/^renews /)).toBeVisible();
    await expect(page.getByRole(`button`, { name: `Subscribe for $20/month` })).toHaveCount(0);
});

test(`the avatar menu carries the plan`, async ({ page }) => {
    await page.goto(`/settings/billing`);
    await page.getByRole(`button`, { name: `Account` }).click();
    await expect(page.getByRole(`link`, { name: /^Hosted plan · renews / })).toBeVisible();
});

test(`a cancel made in Stripe's portal is said as an end date, never as a renewal`, async ({ page }) => {
    await page.goto(`/settings/billing`);
    await page.getByRole(`button`, { name: `Manage on Stripe` }).click();
    await expect(page.getByRole(`heading`, { name: `Fake Stripe portal` })).toBeVisible();
    // Subscription stays active until the period ends; the webhook reports that, not an immediate cancel.
    await page.getByRole(`button`, { name: `Cancel plan` }).click();

    await expect(page).toHaveURL(/\/settings\/billing$/);
    await expect(page.getByText(/^Your plan ends /)).toBeVisible();
    await expect(page.getByText(/^ends /)).toBeVisible();
    await expect(page.getByText(/renews /)).toHaveCount(0);
    await expect(page.getByRole(`button`, { name: `Resume on Stripe` })).toBeVisible();
});

test(`a failed charge asks for a card, and an ended plan is offered again as a resubscription`, async ({ page, request }) => {
    const { subscriptions } = (await (await request.get(`${control}/state`)).json()) as FakeState;
    const live = subscriptions.find((subscription) => subscription.status !== `canceled`);
    expect(live).toMatchObject({ status: `active` });

    // Stripe retrying a charge: past_due, delivered as customer.subscription.updated.
    await request.post(`${control}/update/${live?.id}`, { data: { patch: { status: `past_due`, cancel_at_period_end: false } } });
    await page.goto(`/settings/billing`);
    await expect(page.getByText(`Your plan needs a working card`)).toBeVisible();
    await expect(page.getByRole(`button`, { name: `Update payment on Stripe` })).toBeVisible();
    await expect(page.getByText(`Stripe reports this plan as "past_due".`)).toBeVisible();
    await expect(page.getByRole(`heading`, { name: `Keep your hosted sandbox always on.` })).toHaveCount(0);

    // Fully given up on: customer.subscription.deleted; the offer returns, phrased as a resubscription.
    await request.post(`${control}/update/${live?.id}`, { data: { patch: { status: `canceled` } } });
    await page.goto(`/settings/billing`);
    await expect(page.getByText(`Your previous plan has ended.`)).toBeVisible();
    await expect(page.getByRole(`button`, { name: `Resubscribe for $20/month` }).first()).toBeVisible();
});
