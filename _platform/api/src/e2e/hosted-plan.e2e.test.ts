import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { HostedOffer, HostedPlanState } from "@intentic/api-contract";
import { repoRoot } from "@intentic/constants/node";
import { PrismaClient } from "@intentic/prisma";
import { FREE_TIER, type HostedTier, PAID_TIERS } from "@intentic/constants";
import { e2eTier } from "@intentic/testing/e2e";
import { type FakeFly, installFakeFly } from "@intentic/testing/fly-fake";
import { type FakeStripe, startFakeStripe } from "@intentic/testing/stripe-fake";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Logger } from "pino";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { waitFor, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { createApp } from "../app.js";
import type { Auth } from "../auth.js";
import { configSchema, type Config } from "../config.js";
import { testIngressConfig } from "../testing.js";
import { sandboxHostname } from "../sandbox/reachability.js";
import { hostedSlotsOf, onHostedPlan, slotsAtTier } from "../sandbox/hosted/hosted-plan.js";
import { hostedBudgetOf } from "../sandbox/hosted/hosted-usage.js";
import { DAY_MS } from "../durations.js";

// Runs the real api and router on real Postgres, Stripe stood in for at its one seam: checkout to webhook to mirrored
// row to entitlement read back. Hermetic (Docker only, no secret); the gated tier covers Stripe's own shapes.
const tier = e2eTier(`the hosted plan, end to end: the real api on Postgres, Stripe stood in for`, { enabledBy: `INTENTIC_E2E_HERMETIC` });

const exec = promisify(execFile);

// The pin the platform's own compose file and migrations job run, so the guard matches production's database.
const POSTGRES_IMAGE = `postgres:18.4-alpine3.24`;

const API_ORIGIN = `http://api.test`;
const WEB_ORIGIN = `http://web.test`;
const BETTER_AUTH_SECRET = `hosted-plan-e2e-secret`;
// An http api origin means Better Auth's plain cookie name, no __Secure- prefix (the browser tier has one).
const SESSION_COOKIE = `better-auth.session_token`;
const STRIPE = { secretKey: `sk_test_e2e_hosted_plan`, webhookSecret: `whsec_e2e_hosted_plan`, priceId: `price_e2e_hosted` };
// The cheapest rung on sale, and the free plan's own ceiling: the boot check compares Stripe's amount against
// what the rung advertises, so a figure typed here would fail the run rather than the code.
const ENTRY = PAID_TIERS[0] as HostedTier;
const MONTHLY_HOURS = FREE_TIER.monthlyHours;

const logger = { child: () => logger, info: mock(), warn: mock(), error: mock(), debug: mock() } as unknown as Logger;

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
        // The hosted lane on, so the offer, wake and slot gate exist; Fly itself is answered by the stub below.
        // The ramp off: every person here is seeded minutes old, and this suite's arithmetic is the month's.
        hosted: { flyApiToken: `fly-e2e`, flyOrg: `e2e`, monthlyHours: MONTHLY_HOURS, perUser: 1, newAccountDays: 0, abuseMinutes: 0 },
        hostedPlan: {
            stripeSecretKey: STRIPE.secretKey,
            stripeWebhookSecret: STRIPE.webhookSecret,
            stripePrices: `${ENTRY.id}=${STRIPE.priceId}`,
            stripeApiUrl,
        },
        api: { url: API_ORIGIN, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
        log: { level: `silent`, pretty: `false` },
    });

interface Person {
    readonly id: string;
    readonly email: string;
    readonly cookie: string;
}

// Better Auth's session cookie exactly as the server signs it (better-call signCookieValue).
const sessionCookie = (token: string): string =>
    `${SESSION_COOKIE}=${token}.${createHmac(`sha256`, BETTER_AUTH_SECRET).update(token).digest(`base64`)}`;

const seedPerson = async (prisma: PrismaClient, name: string): Promise<Person> => {
    const id = `e2e-${name}`;
    const email = `${name}@e2e.intentic.dev`;
    const token = randomBytes(24).toString(`base64url`);
    await prisma.user.create({ data: { id, email, name, emailVerified: true } });
    await prisma.session.create({ data: { id: `session-${id}`, token, userId: id, expiresAt: new Date(Date.now() + DAY_MS) } });
    return { id, email, cookie: sessionCookie(token) };
};

// A sandbox with a hosted machine under it, asleep with no open stretch, using the same digest-derived ids the api
// mints. Fly is given the same app, volume and machine: a migration snapshots the disk the row names, and a provider
// that never heard of it answers 404 rather than moving anything.
const seedHostedSandbox = async (prisma: PrismaClient, fly: FakeFly, owner: Person, name: string): Promise<{ id: string; token: string }> => {
    const token = randomBytes(16).toString(`base64url`);
    const digest = createHash(`sha256`).update(token).digest(`hex`);
    const appName = `e2e-${digest.slice(0, 10)}`;
    const machineId = `m-${digest.slice(0, 8)}`;
    const volumeId = `vol-${digest.slice(0, 8)}`;
    const region = `iad`;
    const sandbox = await prisma.sandbox.create({
        data: { name, ownerId: owner.id, token, tokenDigest: digest, tunnelId: digest.slice(0, 12), lastSeenAt: new Date() },
        select: { id: true },
    });
    await prisma.hostedMachine.create({
        data: {
            sandboxId: sandbox.id,
            // The free rung's own shape, read from the ladder: a machine row states what it is, and a figure typed
            // here would describe a machine the product does not hand out.
            tier: FREE_TIER.id,
            cpuKind: FREE_TIER.cpuKind,
            cpus: FREE_TIER.cpus,
            memoryMb: FREE_TIER.memoryMb,
            volumeGb: FREE_TIER.volumeGb,
            appName,
            machineId,
            volumeId,
            region,
        },
    });
    fly.apps.add(appName);
    fly.volumes.set(volumeId, { id: volumeId, app: appName, region, sizeGb: FREE_TIER.volumeGb, state: `created`, usedBytes: 2 * 1024 ** 3 });
    // Stopped, because the row it mirrors is asleep: nothing has woken this machine yet.
    fly.machines.set(machineId, {
        id: machineId,
        app: appName,
        region,
        state: `stopped`,
        config: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    return { id: sandbox.id, token };
};

/* The shared in-memory Fly (@intentic/testing/fly-fake), with everything else — Stripe's stand-in, the api's own
 * requests — passed through to the real fetch it replaced. A local stub answered `started` to every call, which is
 * fine until a case moves a machine and needs the volume it landed on to exist. */
const stubFly = (): FakeFly => installFakeFly((name, value) => stubGlobal(name, value), { passThrough: globalThis.fetch });

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
        headers: {
            ...(opts.as === undefined ? {} : { cookie: opts.as.cookie }),
            ...(opts.body === undefined ? {} : { "content-type": `application/json` }),
        },
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
    let fly: FakeFly;
    let alice: Person;
    let sandboxId: string;
    let connectToken: string;
    let subscriptionId: string;
    let customerId: string;

    const state = (as?: Person) => rpc<HostedPlanState>(app, `/hosted-plan`, { as });
    const offer = () => rpc<HostedOffer>(app, `/sandbox/hosted-offer`, { as: alice });
    const wake = () => rpc<Partial<Refusal> & { ok?: boolean }>(app, `/sandbox/wake`, { as: alice, method: `POST`, body: { sandboxId } });
    const planRow = () => prisma.hostedPlan.findUnique({ where: { userId: alice.id } });

    /* THE DAEMON, PLAYED BY THE SUITE. A machine changed under a sandbox is finished only when the daemon says it came
     * up on the disk it was meant to (hosted-migrate.ts awaitAnnounce), and nothing boots behind the in-memory Fly, so
     * the phone-home has to come from here — through the real route with the real connect token, so a refused one
     * fails this suite instead of leaving it to wait out the deadline.
     *
     * Sent once the machine has been asked to start, never before: the start is issued after the migration read the
     * `lastSeenAt` mark it compares against, so an announce after it cannot be mistaken for the boot before it. The
     * seeded machine is stopped, which is what makes that start happen at all. */
    const announceOnBoot = async (): Promise<void> => {
        await waitFor(() => expect(fly.called(`POST`, `/start`).length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 });
        const said = await app.request(`${API_ORIGIN}/sandbox/announce`, {
            method: `POST`,
            headers: { "content-type": `application/json`, "x-intentic-connect": connectToken },
            body: JSON.stringify({ daemonUrl: `https://${sandboxHostname(config.ingress.zone, connectToken)}` }),
        });
        expect(said.status).toBe(200);
    };

    beforeAll(async () => {
        container = await new GenericContainer(POSTGRES_IMAGE)
            .withEnvironment({ POSTGRES_USER: `app`, POSTGRES_PASSWORD: `app`, POSTGRES_DB: `app`, POSTGRES_INITDB_ARGS: `--no-sync` })
            .withExposedPorts(5432)
            // Twice: the entrypoint's temporary init server says it first, the real one second.
            .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
            .start();
        const databaseUrl = `postgresql://app:app@${container.getHost()}:${container.getMappedPort(5432)}/app`;
        // The real migration history, replayed the way a deployment replays it.
        await exec(`pnpm`, [`--filter`, `@intentic/prisma`, `migrate:deploy`], {
            cwd: repoRoot(import.meta.url),
            env: { ...process.env, DATABASE_URL: databaseUrl },
        });

        // Webhooks reach the api in-process, exactly as Stripe's would reach its port.
        stripe = await startFakeStripe({
            ...STRIPE,
            priceCents: Math.round(ENTRY.priceUsd * 100),
            webhookUrl: `${API_ORIGIN}/hosted-plan/webhook`,
            deliver: async (request) => app.request(request),
        });
        config = configFor(databaseUrl, stripe.url);
        prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
        ({ app, auth } = createApp(config, prisma, logger));
        fly = stubFly();

        alice = await seedPerson(prisma, `alice`);
        const session = await auth.api.getSession({ headers: new Headers({ cookie: alice.cookie }) });
        if (session?.user.email !== alice.email) {
            throw new Error(`the seeded session cookie was rejected: the Better Auth cookie recipe in this suite no longer matches the server`);
        }
    });

    afterAll(async () => {
        unstubAllGlobals();
        await stripe?.close();
        await prisma?.$disconnect();
        await container?.stop();
    });

    it(`sells the plan to everyone and describes the free plan to a signed-in account`, async () => {
        const signedOut = await state();
        expect(signedOut.status).toBe(200);
        expect(signedOut.body).toEqual({ enabled: true, onPlan: false, priceUsd: ENTRY.priceUsd });

        const signedIn = await state(alice);
        expect(signedIn.body).toMatchObject({ enabled: true, onPlan: false, priceUsd: ENTRY.priceUsd });
        expect(signedIn.body.status).toBeUndefined();
        expect(signedIn.body.hosted).toMatchObject({ slots: 1, machines: [], usage: { allowanceMinutes: MONTHLY_HOURS * 60, usedMinutes: 0 } });
    });

    it(`meters the free plan: a spent month refuses the wake and the offer says how many hours are left`, async () => {
        ({ id: sandboxId, token: connectToken } = await seedHostedSandbox(prisma, fly, alice, `alice-box`));
        const month = new Date().toISOString().slice(0, 7);
        await prisma.hostedUsage.create({ data: { ownerId: alice.id, sandboxId, month, minutes: MONTHLY_HOURS * 60 } });

        const refused = await wake();
        expect(refused.status).toBe(402);
        expect(refused.body.code).toBe(`PAYMENT_REQUIRED`);
        expect(fly.calls).toEqual([]);

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
        // The subscription was read fresh off Stripe rather than trusted from the event.
        expect(lastCall(stripe, `GET`, `/subscriptions/${subscriptionId}`)?.authorized).toBe(true);

        const row = await planRow();
        expect(row).toMatchObject({ stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId, status: `active`, cancelAtPeriodEnd: false });
        // One slot row per rung the subscription bought, named by the price's rung rather than by its position.
        expect(await prisma.hostedPlanItem.findMany({ where: { planId: row?.id } })).toEqual([
            expect.objectContaining({ tier: ENTRY.id, stripeItemId: subscription.items[0]?.id, quantity: 1 }),
        ]);

        // The Billing page's read.
        const { body } = await state(alice);
        expect(body).toMatchObject({ onPlan: true, status: `active` });
        expect(body.comped).toBeUndefined();
        expect(body.cancelAtPeriodEnd).toBeUndefined();
        expect(within(body.renewsAt, Date.now() + 30 * DAY_MS, 60_000)).toBe(true);

        /* BUYING A SLOT DOES NOT CHANGE THE MACHINE. The account now holds a Standard slot beside its free one, and
         * the sandbox is still the free machine it was until it is moved onto that slot (changeTier below). */
        expect((await offer()).body).toMatchObject({ enabled: true, plan: true });
        const slots = await hostedSlotsOf(prisma, config, alice.id);
        expect(slotsAtTier(slots, ENTRY.id)).toBe(1);
        expect(slots.total).toBe(2);
        expect(await hostedBudgetOf(prisma, config, { sandboxId, tier: FREE_TIER.id, ownerId: alice.id })).toMatchObject({
            metered: true,
            allowanceMinutes: MONTHLY_HOURS * 60,
        });

        // The wake refused a minute ago is still refused: the machine's own month is still spent.
        expect((await wake()).status).toBe(402);
        // Moved onto the slot, it is a Standard machine with Standard's hours, and the wake goes through.
        const [moved] = await Promise.all([
            rpc<{ state: string }>(app, `/hosted-plan/tier`, { as: alice, method: `POST`, body: { sandboxId, tier: ENTRY.id } }),
            announceOnBoot(),
        ]);
        expect(moved.status).toBe(200);
        expect(moved.body.state).toBe(`done`);
        expect(await prisma.hostedMachine.findUnique({ where: { sandboxId }, select: { tier: true, cpus: true, memoryMb: true } })).toEqual({
            tier: ENTRY.id,
            cpus: ENTRY.cpus,
            memoryMb: ENTRY.memoryMb,
        });
        fly.calls.length = 0;
        const woken = await wake();
        expect(woken.status).toBe(200);
        expect(woken.body).toEqual({ ok: true });
        // One call, and it is the start: the wake flips power and nothing else.
        expect(fly.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
            expect.stringMatching(/^POST \/v1\/apps\/e2e-[0-9a-f]+\/machines\/m-[0-9a-f]+\/start$/u),
        ]);
        expect((await state(alice)).body.hosted?.machines).toEqual([
            expect.objectContaining({ sandboxId, name: `alice-box`, region: `iad`, wokeAt: expect.any(String) }),
        ]);
    });

    it(`refuses a second checkout while the plan is live, before Stripe is asked`, async () => {
        const before = stripe.calls.length;
        const again = await rpc<Refusal>(app, `/hosted-plan/checkout`, { as: alice, method: `POST` });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe(`CONFLICT`);
        expect(stripe.calls.length).toBe(before);
    });

    it(`sells a second slot with proration, refuses to sell back the one a machine stands on, and caps the count`, async () => {
        const two = await rpc<HostedPlanState>(app, `/hosted-plan/slots`, { as: alice, method: `POST`, body: { tier: ENTRY.id, quantity: 2 } });
        expect(two.status).toBe(200);
        expect(two.body.hosted?.slotsByTier[ENTRY.id]).toBe(2);
        const call = lastCall(stripe, `POST`, `/subscriptions/${subscriptionId}`);
        expect(call?.authorized).toBe(true);
        expect(call?.params).toEqual({
            "items[0][id]": stripe.subscriptions.get(subscriptionId)!.items[0]!.id,
            "items[0][quantity]": `2`,
            proration_behavior: `create_prorations`,
        });
        expect(slotsAtTier(await hostedSlotsOf(prisma, config, alice.id), ENTRY.id)).toBe(2);

        // Stripe's own event for the change followed the api's write and was accepted; the guard did not roll it back.
        expect(await prisma.hostedPlanItem.findFirst({ where: { tier: ENTRY.id } })).toMatchObject({ quantity: 2 });

        // The sandbox moved up a rung earlier stands on one of them: that one cannot be sold back under it.
        const under = await rpc<Refusal>(app, `/hosted-plan/slots`, { as: alice, method: `POST`, body: { tier: ENTRY.id, quantity: 0 } });
        expect(under.status).toBe(400);
        expect(under.body.message).toContain(`move one down a rung`);

        // The contract's ceiling holds at the door.
        const eleven = await rpc<Refusal>(app, `/hosted-plan/slots`, { as: alice, method: `POST`, body: { tier: ENTRY.id, quantity: 11 } });
        expect(eleven.status).toBe(400);

        const one = await rpc<HostedPlanState>(app, `/hosted-plan/slots`, { as: alice, method: `POST`, body: { tier: ENTRY.id, quantity: 1 } });
        expect(one.status).toBe(200);
        expect(one.body.hosted?.slotsByTier[ENTRY.id]).toBe(1);
    });

    it(`opens the portal for the customer Stripe knows, back to the Billing page`, async () => {
        const portal = await rpc<{ url: string }>(app, `/hosted-plan/portal`, { as: alice, method: `POST` });
        expect(portal.status).toBe(200);
        expect(portal.body.url.startsWith(`${stripe.origin}/portal/${customerId}`)).toBe(true);
        expect(lastCall(stripe, `POST`, `/billing_portal/sessions`)?.params).toEqual({
            customer: customerId,
            return_url: `${WEB_ORIGIN}/settings/billing`,
        });
    });

    it(`mirrors a cancel made in the portal as an end date, still on the plan until then`, async () => {
        expect((await stripe.update(subscriptionId, { cancel_at_period_end: true })).status).toBe(200);
        const { body } = await state(alice);
        expect(body).toMatchObject({ onPlan: true, status: `active`, cancelAtPeriodEnd: true });
        expect(await onHostedPlan(prisma, config, alice.id)).toBe(true);
    });

    it(`pauses the plan on a failed charge: the slot it bought stops counting and the free plan is metered again`, async () => {
        expect((await stripe.update(subscriptionId, { status: `past_due`, cancel_at_period_end: false })).status).toBe(200);
        const { body } = await state(alice);
        expect(body).toMatchObject({ onPlan: false, status: `past_due` });
        expect(body.cancelAtPeriodEnd).toBeUndefined();
        expect(body.hosted?.usage.allowanceMinutes).toBe(MONTHLY_HOURS * 60);
        // An unpaid charge takes the slot away; the machine standing on that rung stays where it is until it is moved.
        expect(slotsAtTier(await hostedSlotsOf(prisma, config, alice.id), ENTRY.id)).toBe(0);
        expect(await hostedBudgetOf(prisma, config, { sandboxId, tier: ENTRY.id, ownerId: alice.id })).toMatchObject({ metered: true });
        // The free slot is empty and offered again: this account's one machine stands on the Standard rung it moved to
        // earlier, and the card offers a free machine.
        expect((await offer()).body).toEqual({ enabled: true, remaining: 1, hours: { allowance: MONTHLY_HOURS, remaining: 0 } });
        // The wake is judged against the machine's OWN rung, not the account's lane (docs/design/hosted-machines.md):
        // the spent forty hours are the free plan's, and a Standard machine is nowhere near Standard's ceiling.
        expect((await wake()).status).toBe(200);
    });

    it(`refuses a webhook without Stripe's signature, with another secret, or from outside the replay window`, async () => {
        const object = { id: subscriptionId, customer: customerId, status: `active` };
        const unsigned = await app.request(`${API_ORIGIN}/hosted-plan/webhook`, {
            method: `POST`,
            body: JSON.stringify({ type: `customer.subscription.updated`, data: { object } }),
        });
        expect(unsigned.status).toBe(400);
        expect((await stripe.emit(`customer.subscription.updated`, object, { secret: `whsec_somebody_else` })).status).toBe(400);
        expect((await stripe.emit(`customer.subscription.updated`, object, { at: new Date(Date.now() - 10 * 60_000) })).status).toBe(400);
        // None of the three refusals moved the row.
        expect((await planRow())?.status).toBe(`past_due`);
    });

    it(`takes events in any order, never trusting their copy of the subscription, and takes the same event twice`, async () => {
        expect((await stripe.update(subscriptionId, { status: `active` })).status).toBe(200);
        expect((await planRow())?.status).toBe(`active`);

        // A stale event from two minutes ago: the row follows what Stripe says now, not what the event said then.
        const stale = { id: subscriptionId, object: `subscription`, customer: customerId, status: `past_due` };
        expect((await stripe.emit(`customer.subscription.updated`, stale, { createdAt: new Date(Date.now() - 120_000) })).status).toBe(200);
        expect((await planRow())?.status).toBe(`active`);
        expect((await state(alice)).body.onPlan).toBe(true);

        // Stripe retries until it hears 200; the same state twice is the same state.
        expect((await stripe.update(subscriptionId, { status: `active` })).status).toBe(200);
        expect((await stripe.update(subscriptionId, { status: `active` })).status).toBe(200);
        expect((await planRow())?.status).toBe(`active`);

        // A non-subscription-shaped event is acknowledged and ignored, so Stripe stops sending it.
        expect((await stripe.emit(`customer.subscription.updated`, `not an object`)).status).toBe(200);
        expect((await planRow())?.status).toBe(`active`);
    });

    it(`ends the plan when Stripe ends the subscription, then sells it again to the same customer`, async () => {
        expect((await stripe.update(subscriptionId, { status: `canceled` })).status).toBe(200);
        const ended = await state(alice);
        expect(ended.body).toMatchObject({ onPlan: false, status: `canceled` });
        expect(await hostedBudgetOf(prisma, config, { sandboxId, tier: FREE_TIER.id, ownerId: alice.id })).toMatchObject({ metered: true });

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
        const row = await planRow();
        expect(row).toMatchObject({ stripeSubscriptionId: subscriptionId, status: `active` });
        // And one slot at the entry rung again, mirrored off the new subscription rather than left from the old one.
        expect(await prisma.hostedPlanItem.findMany({ where: { planId: row?.id } })).toEqual([
            expect.objectContaining({ tier: ENTRY.id, stripeItemId: subscription.items[0]?.id, quantity: 1 }),
        ]);
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
        expect(body.hosted?.usage.allowanceMinutes).toBe(MONTHLY_HOURS * 60);
        expect(await prisma.hostedPlan.findUnique({ where: { userId: bob.id } })).toBeNull();

        // Off the list, the same account is on the free plan: nothing was ever written down.
        expect((await state(bob)).body).toMatchObject({ onPlan: false });
        expect(stripe.calls.some((call) => call.params[`client_reference_id`] === bob.id)).toBe(false);
    });
});
