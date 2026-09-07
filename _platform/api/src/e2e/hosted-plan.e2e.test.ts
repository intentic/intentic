import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { HostedOffer, HostedPlanState } from "@intentic/api-contract";
import { repoRoot } from "@intentic/constants/node";
import { PrismaClient } from "@intentic/prisma";
import { e2eTier } from "@intentic/testing/e2e";
import { type FakeStripe, startFakeStripe } from "@intentic/testing/stripe-fake";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Logger } from "pino";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Auth } from "../auth.js";
import { configSchema, type Config } from "../config.js";
import { testIngressConfig } from "../testing.js";
import { hostedSlotsOf, onHostedPlan } from "../sandbox/hosted/hosted-plan.js";
import { hostedBudgetOf } from "../sandbox/hosted/hosted-usage.js";

/* THE MONEY PATH AS ONE SYSTEM. hosted-plan.test.ts pins each module against a hand-written Prisma; this
 * suite runs the real api (createApp, the real router, Better Auth's real session and deletion hook) on a
 * real Postgres, with Stripe stood in for by @intentic/testing/stripe-fake at the one seam the client has
 * (HOSTED_PLAN_STRIPE_API_URL). What it proves is the chain nothing else can: a checkout the real client
 * encoded, completed on "Stripe", delivered as a signed webhook to the real route, mirrored by the real
 * `updateMany` guard into a real row, and READ BACK as the entitlement the rest of the platform acts on: the
 * wake that was refused is allowed, the offer says "on your plan", the meter comes off. Then every way the
 * plan changes afterwards: a slot bought with proration, a cancel in the portal, a failed charge, an ended
 * plan, the same customer buying again, and the account being deleted with its subscription.
 *
 * HERMETIC. A Docker daemon is the whole requirement (the Postgres is a testcontainer), which is what earns it
 * a run on every merge request beside the CLI's hermetic tier rather than nightly. It reads that tier's own
 * switch and no secret. Stripe's own shapes are the one thing it cannot vouch for; hosted-plan-stripe.e2e.test.ts
 * is the gated tier that does. */
const tier = e2eTier(`the hosted plan, end to end: the real api on Postgres, Stripe stood in for`, { enabledBy: `INTENTIC_E2E_HERMETIC` });

const exec = promisify(execFile);

// The pin the platform's own compose file and the migrations job run, so the guard is checked on the database
// production replays into.
const POSTGRES_IMAGE = `postgres:18.4-alpine3.24`;

const API_ORIGIN = `http://api.test`;
const WEB_ORIGIN = `http://web.test`;
const BETTER_AUTH_SECRET = `hosted-plan-e2e-secret`;
// An http api origin means Better Auth's plain cookie name, no __Secure- prefix (the browser tier has that one).
const SESSION_COOKIE = `better-auth.session_token`;
const STRIPE = { secretKey: `sk_test_e2e_hosted_plan`, webhookSecret: `whsec_e2e_hosted_plan`, priceId: `price_e2e_hosted` };
const MONTHLY_HOURS = 40;
const DAY_MS = 86_400_000;

const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const configFor = (databaseUrl: string, stripeApiUrl: string): Config =>
    configSchema.parse({
        database: { url: databaseUrl, poolMax: 5 },
        betterAuth: { secret: BETTER_AUTH_SECRET },
        secrets: { key: `` },
        webOrigin: WEB_ORIGIN,
        google: { clientId: ``, clientSecret: `` },
        email: { apiKey: ``, from: `` },
        intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: `true` },
        ingress: testIngressConfig,
        // The hosted lane on, so the offer, the wake and the slot gate exist; Fly is answered by the stub below.
        hosted: { flyApiToken: `fly-e2e`, flyOrg: `e2e`, monthlyHours: MONTHLY_HOURS, perUser: 1 },
        hostedPlan: { ...STRIPE, stripeSecretKey: STRIPE.secretKey, stripeWebhookSecret: STRIPE.webhookSecret, stripePriceId: STRIPE.priceId, stripeApiUrl, priceUsd: 20 },
        api: { url: API_ORIGIN, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
        log: { level: `silent`, pretty: `false` },
    });

interface Person {
    readonly id: string;
    readonly email: string;
    readonly cookie: string;
}

// Better Auth's session cookie as the server signs it (better-call signCookieValue): the token, a dot, and
// HMAC-SHA256(secret, token) in base64. Proven against the real session read before any test rests on it.
const sessionCookie = (token: string): string => `${SESSION_COOKIE}=${token}.${createHmac(`sha256`, BETTER_AUTH_SECRET).update(token).digest(`base64`)}`;

const seedPerson = async (prisma: PrismaClient, name: string): Promise<Person> => {
    const id = `e2e-${name}`;
    const email = `${name}@e2e.intentic.dev`;
    const token = randomBytes(24).toString(`base64url`);
    await prisma.user.create({ data: { id, email, name, emailVerified: true } });
    await prisma.session.create({ data: { id: `session-${id}`, token, userId: id, expiresAt: new Date(Date.now() + DAY_MS) } });
    return { id, email, cookie: sessionCookie(token) };
};

// A sandbox with a hosted machine under it, asleep with no open stretch. The same digest-derived ids the api
// mints (sandboxIdFromToken), so the row is one a URL could name.
const seedHostedSandbox = async (prisma: PrismaClient, owner: Person, name: string): Promise<{ id: string }> => {
    const token = randomBytes(16).toString(`base64url`);
    const digest = createHash(`sha256`).update(token).digest(`hex`);
    const sandbox = await prisma.sandbox.create({
        data: { name, ownerId: owner.id, token, tokenDigest: digest, tunnelId: digest.slice(0, 12), lastSeenAt: new Date() },
        select: { id: true },
    });
    await prisma.hostedMachine.create({
        data: { sandboxId: sandbox.id, appName: `e2e-${digest.slice(0, 10)}`, machineId: `m-${digest.slice(0, 8)}`, volumeId: `vol-${digest.slice(0, 8)}`, region: `iad` },
    });
    return sandbox;
};

/* FLY, ANSWERED. The wake is the one route here that reaches the provider after the gate, and it is the route
 * whose gate is under test, so the provider answers "started" to everything and the calls are kept for the
 * assertion. Everything else the api fetches (the Stripe stand-in) goes through untouched. */
const stubFly = (): string[] => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    vi.stubGlobal(`fetch`, (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === `string` ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(`https://api.machines.dev/`)) {
            return realFetch(input, init);
        }
        calls.push(`${init?.method ?? `GET`} ${new URL(url).pathname}`);
        return Promise.resolve(new Response(JSON.stringify({ id: `m1`, state: `started` }), { headers: { "content-type": `application/json` } }));
    });
    return calls;
};

type App = ReturnType<typeof createApp>[`app`];

interface Answer<T> {
    readonly status: number;
    readonly body: T;
}

// An oRPC call through the real HTTP surface, as the browser makes it: the session cookie, JSON in, JSON out.
const rpc = async <T = Record<string, unknown>>(
    app: App,
    path: string,
    opts: { readonly as?: Person; readonly method?: `GET` | `POST`; readonly body?: unknown } = {},
): Promise<Answer<T>> => {
    const response = await app.request(`${API_ORIGIN}/rpc${path}`, {
        method: opts.method ?? `GET`,
        headers: { ...(opts.as === undefined ? {} : { cookie: opts.as.cookie }), ...(opts.body === undefined ? {} : { "content-type": `application/json` }) },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text === `` ? undefined : JSON.parse(text)) as T };
};

interface Refusal {
    readonly code: string;
    readonly message: string;
}

const lastCall = (stripe: FakeStripe, method: string, path: string) =>
    stripe.calls.toReversed().find((call) => call.method === method && call.path === path);

const within = (iso: string | undefined, expectedMs: number, toleranceMs: number): boolean =>
    iso !== undefined && Math.abs(new Date(iso).getTime() - expectedMs) <= toleranceMs;

describe.skipIf(!tier.runs)(tier.title, () => {
    let container: StartedTestContainer | undefined;
    let prisma: PrismaClient;
    let stripe: FakeStripe;
    let config: Config;
    let app: App;
    let auth: Auth;
    let flyCalls: string[];
    let alice: Person;
    let sandboxId: string;
    let subscriptionId: string;
    let customerId: string;

    const state = (as?: Person) => rpc<HostedPlanState>(app, `/hosted-plan`, { as });
    const offer = () => rpc<HostedOffer>(app, `/sandbox/hosted-offer`, { as: alice });
    const wake = () => rpc<Refusal & { ok?: boolean }>(app, `/sandbox/wake`, { as: alice, method: `POST`, body: { sandboxId } });
    const planRow = () => prisma.hostedPlan.findUnique({ where: { userId: alice.id } });

    beforeAll(async () => {
        container = await new GenericContainer(POSTGRES_IMAGE)
            .withEnvironment({ POSTGRES_USER: `app`, POSTGRES_PASSWORD: `app`, POSTGRES_DB: `app`, POSTGRES_INITDB_ARGS: `--no-sync` })
            .withExposedPorts(5432)
            // Twice: the entrypoint's temporary server during init says it first, the real one second.
            .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
            .start();
        const databaseUrl = `postgresql://app:app@${container.getHost()}:${container.getMappedPort(5432)}/app`;
        // The real migration history, replayed the way a deployment replays it.
        await exec(`pnpm`, [`--filter`, `@intentic/prisma`, `migrate:deploy`], { cwd: repoRoot(import.meta.url), env: { ...process.env, DATABASE_URL: databaseUrl } });

        // Webhooks reach the api in-process, exactly as Stripe's would reach its port.
        stripe = await startFakeStripe({ ...STRIPE, webhookUrl: `${API_ORIGIN}/hosted-plan/webhook`, deliver: async (request) => app.request(request) });
        config = configFor(databaseUrl, stripe.url);
        prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
        ({ app, auth } = createApp(config, prisma, logger));
        flyCalls = stubFly();

        alice = await seedPerson(prisma, `alice`);
        const session = await auth.api.getSession({ headers: new Headers({ cookie: alice.cookie }) });
        if (session?.user.email !== alice.email) {
            throw new Error(`the seeded session cookie was rejected: the Better Auth cookie recipe in this suite no longer matches the server`);
        }
    });

    afterAll(async () => {
        vi.unstubAllGlobals();
        await stripe?.close();
        await prisma?.$disconnect();
        await container?.stop();
    });

    it(`sells the plan to everyone and describes the free lane to a signed-in account`, async () => {
        const signedOut = await state();
        expect(signedOut.status).toBe(200);
        expect(signedOut.body).toEqual({ enabled: true, onPlan: false, priceUsd: 20 });

        const signedIn = await state(alice);
        expect(signedIn.body).toMatchObject({ enabled: true, onPlan: false, priceUsd: 20 });
        expect(signedIn.body.status).toBeUndefined();
        expect(signedIn.body.hosted).toMatchObject({ slots: 1, machines: [], usage: { allowanceMinutes: MONTHLY_HOURS * 60, usedMinutes: 0 } });
    });

    it(`meters the free lane: a spent month refuses the wake and the offer says how many hours are left`, async () => {
        ({ id: sandboxId } = await seedHostedSandbox(prisma, alice, `alice-box`));
        const month = new Date().toISOString().slice(0, 7);
        await prisma.hostedUsage.create({ data: { userId: alice.id, month, minutes: MONTHLY_HOURS * 60 } });

        const refused = await wake();
        expect(refused.status).toBe(402);
        expect(refused.body.code).toBe(`PAYMENT_REQUIRED`);
        expect(flyCalls).toEqual([]);

        const offered = await offer();
        expect(offered.body).toEqual({ enabled: true, remaining: 0, hours: { allowance: MONTHLY_HOURS, remaining: 0 } });
    });

    it(`mints a checkout for the buyer with the price and both return addresses, and writes nothing yet`, async () => {
        const checkout = await rpc<{ url: string }>(app, `/hosted-plan/checkout`, { as: alice, method: `POST` });
        expect(checkout.status).toBe(200);
        expect(checkout.body.url.startsWith(`${stripe.origin}/checkout/cs_test_`)).toBe(true);

        const call = lastCall(stripe, `POST`, `/checkout/sessions`);
        expect(call?.authorized).toBe(true);
        expect(call?.params).toEqual({
            mode: `subscription`,
            "line_items[0][price]": STRIPE.priceId,
            "line_items[0][quantity]": `1`,
            client_reference_id: alice.id,
            customer_email: alice.email,
            success_url: `${WEB_ORIGIN}/settings/billing?plan=welcome`,
            cancel_url: `${WEB_ORIGIN}/settings/billing`,
        });
        // A checkout the buyer abandons leaves nothing behind: the webhook is what makes the plan.
        expect(await planRow()).toBeNull();
        expect((await state(alice)).body.onPlan).toBe(false);
    });

    it(`turns the paid checkout into a live plan the whole platform recognises`, async () => {
        const session = [...stripe.sessions.values()].find((candidate) => candidate.client_reference_id === alice.id);
        expect(session).toMatchObject({ status: `open`, client_reference_id: alice.id, price: STRIPE.priceId, quantity: 1 });
        const { subscription, delivered } = await stripe.complete(session?.id ?? ``);
        expect(delivered.status).toBe(200);
        subscriptionId = subscription.id;
        customerId = subscription.customer;
        // The subscription was read fresh off "Stripe" rather than trusted from the event.
        expect(lastCall(stripe, `GET`, `/subscriptions/${subscriptionId}`)?.authorized).toBe(true);

        const row = await planRow();
        expect(row).toMatchObject({
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            stripeItemId: subscription.item.id,
            status: `active`,
            cancelAtPeriodEnd: false,
            quantity: 1,
        });

        // The Billing page's read.
        const { body } = await state(alice);
        expect(body).toMatchObject({ onPlan: true, status: `active` });
        expect(body.comped).toBeUndefined();
        expect(body.cancelAtPeriodEnd).toBeUndefined();
        expect(within(body.renewsAt, Date.now() + 30 * DAY_MS, 60_000)).toBe(true);
        expect(body.hosted?.usage.allowanceMinutes).toBeNull();

        // The rest of the platform's reads: the offer, the meter, the slot count.
        expect((await offer()).body).toEqual({ enabled: true, remaining: 0, plan: true });
        expect(await hostedBudgetOf(prisma, config, alice.id)).toMatchObject({ metered: false });
        expect(await hostedSlotsOf(prisma, config, alice.id)).toBe(1);

        // And the wake that was refused a minute ago goes through to the provider.
        const woken = await wake();
        expect(woken.status).toBe(200);
        expect(woken.body).toEqual({ ok: true });
        expect(flyCalls).toEqual([expect.stringMatching(/^POST \/v1\/apps\/e2e-[0-9a-f]+\/machines\/m-[0-9a-f]+\/start$/)]);
        expect((await state(alice)).body.hosted?.machines).toEqual([expect.objectContaining({ sandboxId, name: `alice-box`, region: `iad`, wokeAt: expect.any(String) })]);
    });

    it(`refuses a second checkout while the plan is live, before Stripe is asked`, async () => {
        const before = stripe.calls.length;
        const again = await rpc<Refusal>(app, `/hosted-plan/checkout`, { as: alice, method: `POST` });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe(`CONFLICT`);
        expect(stripe.calls.length).toBe(before);
    });

    it(`sells a second slot with proration, refuses to sell back the one a machine stands on, and caps the count`, async () => {
        const two = await rpc<HostedPlanState>(app, `/hosted-plan/slots`, { as: alice, method: `POST`, body: { quantity: 2 } });
        expect(two.status).toBe(200);
        expect(two.body.hosted?.slots).toBe(2);
        const call = lastCall(stripe, `POST`, `/subscriptions/${subscriptionId}`);
        expect(call?.authorized).toBe(true);
        expect(call?.params).toEqual({
            "items[0][id]": stripe.subscriptions.get(subscriptionId)?.item.id,
            "items[0][quantity]": `2`,
            proration_behavior: `create_prorations`,
        });
        expect((await planRow())?.quantity).toBe(2);
        expect(await hostedSlotsOf(prisma, config, alice.id)).toBe(2);
        expect((await offer()).body.remaining).toBe(1);

        // Stripe's own `customer.subscription.updated` for the change followed the api's write and was
        // accepted: the row is the same state either way, and the guard did not roll it back.
        expect((await planRow())?.quantity).toBe(2);

        // A second machine now stands on the second slot: the slot cannot be sold back under it.
        const second = await seedHostedSandbox(prisma, alice, `alice-second`);
        const under = await rpc<Refusal>(app, `/hosted-plan/slots`, { as: alice, method: `POST`, body: { quantity: 1 } });
        expect(under.status).toBe(400);
        expect(under.body.message).toContain(`remove one before giving up its slot`);

        // The contract's ceiling holds at the door.
        const eleven = await rpc<Refusal>(app, `/hosted-plan/slots`, { as: alice, method: `POST`, body: { quantity: 11 } });
        expect(eleven.status).toBe(400);

        await prisma.sandbox.delete({ where: { id: second.id } });
        const one = await rpc<HostedPlanState>(app, `/hosted-plan/slots`, { as: alice, method: `POST`, body: { quantity: 1 } });
        expect(one.status).toBe(200);
        expect(one.body.hosted?.slots).toBe(1);
    });

    it(`opens the portal for the customer Stripe knows, back to the Billing page`, async () => {
        const portal = await rpc<{ url: string }>(app, `/hosted-plan/portal`, { as: alice, method: `POST` });
        expect(portal.status).toBe(200);
        expect(portal.body.url.startsWith(`${stripe.origin}/portal/${customerId}`)).toBe(true);
        expect(lastCall(stripe, `POST`, `/billing_portal/sessions`)?.params).toEqual({ customer: customerId, return_url: `${WEB_ORIGIN}/settings/billing` });
    });

    it(`mirrors a cancel made in the portal as an end date, still on the plan until then`, async () => {
        expect((await stripe.update(subscriptionId, { cancel_at_period_end: true })).status).toBe(200);
        const { body } = await state(alice);
        expect(body).toMatchObject({ onPlan: true, status: `active`, cancelAtPeriodEnd: true });
        expect(await onHostedPlan(prisma, config, alice.id)).toBe(true);
    });

    it(`pauses the plan on a failed charge: the meter is back, and the wake is refused again`, async () => {
        expect((await stripe.update(subscriptionId, { status: `past_due`, cancel_at_period_end: false })).status).toBe(200);
        const { body } = await state(alice);
        expect(body).toMatchObject({ onPlan: false, status: `past_due` });
        expect(body.cancelAtPeriodEnd).toBeUndefined();
        expect(body.hosted?.usage.allowanceMinutes).toBe(MONTHLY_HOURS * 60);
        expect(await hostedBudgetOf(prisma, config, alice.id)).toMatchObject({ metered: true, remainingMinutes: 0 });
        expect((await offer()).body).toEqual({ enabled: true, remaining: 0, hours: { allowance: MONTHLY_HOURS, remaining: 0 } });
        expect((await wake()).status).toBe(402);
    });

    it(`refuses a webhook without Stripe's signature, with another secret, or from outside the replay window`, async () => {
        const object = { id: subscriptionId, customer: customerId, status: `active` };
        const unsigned = await app.request(`${API_ORIGIN}/hosted-plan/webhook`, { method: `POST`, body: JSON.stringify({ type: `customer.subscription.updated`, data: { object } }) });
        expect(unsigned.status).toBe(400);
        expect((await stripe.emit(`customer.subscription.updated`, object, { secret: `whsec_somebody_else` })).status).toBe(400);
        expect((await stripe.emit(`customer.subscription.updated`, object, { at: new Date(Date.now() - 10 * 60_000) })).status).toBe(400);
        // None of them moved the row.
        expect((await planRow())?.status).toBe(`past_due`);
    });

    it(`takes events in any order, never trusting their copy of the subscription, and takes the same event twice`, async () => {
        expect((await stripe.update(subscriptionId, { status: `active` })).status).toBe(200);
        expect((await planRow())?.status).toBe(`active`);

        // An event Stripe emitted two minutes ago carrying a state it has since left: the row follows what
        // Stripe SAYS NOW, which is what the webhook reads, not what the event said then.
        const stale = { id: subscriptionId, object: `subscription`, customer: customerId, status: `past_due` };
        expect((await stripe.emit(`customer.subscription.updated`, stale, { createdAt: new Date(Date.now() - 120_000) })).status).toBe(200);
        expect((await planRow())?.status).toBe(`active`);
        expect((await state(alice)).body.onPlan).toBe(true);

        // Stripe retries until it hears 200; the same state twice is the same state.
        expect((await stripe.update(subscriptionId, { status: `active` })).status).toBe(200);
        expect((await stripe.update(subscriptionId, { status: `active` })).status).toBe(200);
        expect((await planRow())?.status).toBe(`active`);

        // An event of a shape that is not a subscription is acknowledged and ignored, so Stripe stops sending it.
        expect((await stripe.emit(`customer.subscription.updated`, `not an object`)).status).toBe(200);
        expect((await planRow())?.status).toBe(`active`);
    });

    it(`ends the plan when Stripe ends the subscription, then sells it again to the same customer`, async () => {
        expect((await stripe.update(subscriptionId, { status: `canceled` })).status).toBe(200);
        const ended = await state(alice);
        expect(ended.body).toMatchObject({ onPlan: false, status: `canceled` });
        expect(await hostedBudgetOf(prisma, config, alice.id)).toMatchObject({ metered: true });

        // The resubscriber is the customer they were: addressed by id, with no email beside it.
        const checkout = await rpc<{ url: string }>(app, `/hosted-plan/checkout`, { as: alice, method: `POST` });
        expect(checkout.status).toBe(200);
        const call = lastCall(stripe, `POST`, `/checkout/sessions`);
        expect(call?.params[`customer`]).toBe(customerId);
        expect(call?.params[`customer_email`]).toBeUndefined();

        const session = [...stripe.sessions.values()].find((candidate) => candidate.status === `open` && candidate.client_reference_id === alice.id);
        const { subscription } = await stripe.complete(session?.id ?? ``);
        expect(subscription.id).not.toBe(subscriptionId);
        expect(subscription.customer).toBe(customerId);
        subscriptionId = subscription.id;

        // One row per user through the churn: the unique customer and subscription columns held.
        expect(await prisma.hostedPlan.count({ where: { stripeCustomerId: customerId } })).toBe(1);
        expect(await planRow()).toMatchObject({ stripeSubscriptionId: subscriptionId, status: `active`, quantity: 1 });
        expect((await state(alice)).body).toMatchObject({ onPlan: true, status: `active` });
    });

    it(`ends the subscription on Stripe before the account goes, through Better Auth's real deletion`, async () => {
        const deleted = await auth.api.deleteUser({ headers: new Headers({ cookie: alice.cookie }), body: {} });
        expect(deleted).toMatchObject({ success: true });

        const cancel = lastCall(stripe, `DELETE`, `/subscriptions/${subscriptionId}`);
        expect(cancel?.authorized).toBe(true);
        expect(stripe.subscriptions.get(subscriptionId)?.status).toBe(`canceled`);
        expect(await prisma.user.findUnique({ where: { id: alice.id } })).toBeNull();
        expect(await prisma.hostedPlan.findUnique({ where: { stripeCustomerId: customerId } })).toBeNull();
    });

    it(`puts an account on the operator's comp list on the plan with no row and no charge`, async () => {
        const bob = await seedPerson(prisma, `bob`);
        const comped = { ...config, hostedPlan: { ...config.hostedPlan, compEmails: ` ${bob.email.toUpperCase()} ` } };
        const compedApp = createApp(comped, prisma, logger).app;

        const { body } = await rpc<HostedPlanState>(compedApp, `/hosted-plan`, { as: bob });
        expect(body).toMatchObject({ enabled: true, onPlan: true, comped: true });
        expect(body.status).toBeUndefined();
        expect(body.hosted?.usage.allowanceMinutes).toBeNull();
        expect(await hostedBudgetOf(prisma, comped, bob.id)).toMatchObject({ metered: false });
        expect(await prisma.hostedPlan.findUnique({ where: { userId: bob.id } })).toBeNull();

        // Off the list, the same account is on the free lane: nothing was ever written down.
        expect((await state(bob)).body).toMatchObject({ onPlan: false });
        expect(stripe.calls.some((call) => call.params[`client_reference_id`] === bob.id)).toBe(false);
    });
});
