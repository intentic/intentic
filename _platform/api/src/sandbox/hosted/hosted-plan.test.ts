import { createHmac } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import { describe, expect, it, vi } from "vitest";
import { configSchema, type Config } from "../../config.js";
import { cancelHostedPlan, hostedSlotsOf, onHostedPlan } from "./hosted-plan.js";
import type { StripeGateway } from "./hosted-plan-stripe.js";
import { hostedPlanHttpRoutes } from "./hosted-plan.routes.js";

/* THE PLAN IS THE ONE THING SOLD, so what is pinned is what a buyer would call betrayal if it drifted: being
 * on the plan meaning a paid, current row (or the operator's own comp list) and nothing less; the webhook
 * refusing an unsigned event while honouring a signed one and never rolling the mirror back to a state Stripe
 * has left; a deleted account's subscription ending with it; and the slot count being the plan's quantity. */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const NOW = new Date(`2026-09-06T12:00:00Z`);

const baseConfig = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: `true` },
    ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
    trial: { keys: ``, baseUrl: `https://upstream.test/v1beta/openai`, models: ``, dailyMessages: 2 },
    hostedPlan: { stripeSecretKey: `sk_test`, stripeWebhookSecret: `whsec_test`, stripePriceId: `price_1`, priceUsd: 20 },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

const configWith = (hostedPlan: Partial<Config[`hostedPlan`]>): Config => ({ ...baseConfig, hostedPlan: { ...baseConfig.hostedPlan, ...hostedPlan } });

interface PlanRow {
    userId: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    stripeItemId?: string;
    status: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd?: boolean;
    quantity?: number;
    syncedAt?: Date;
}

// Enough Prisma for the plan: the user lookup the comp list needs, and the plan reads/writes the webhook makes.
const fakePrisma = (seed?: { plans?: PlanRow[]; users?: { id: string; email: string }[] }) => {
    const plans = seed?.plans ?? [];
    const users = seed?.users ?? [];
    const prisma = {
        user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users.find((user) => user.id === where.id) ?? null) },
        hostedPlan: {
            findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => plans.find((plan) => plan.userId === where.userId) ?? null),
            upsert: vi.fn(async ({ where, create, update }: { where: { userId: string }; create: PlanRow; update: Partial<PlanRow> }) => {
                const existing = plans.find((plan) => plan.userId === where.userId);
                if (existing === undefined) {
                    plans.push(create);
                    return create;
                }
                Object.assign(existing, update);
                return existing;
            }),
            // Honours the ordering guard the way Postgres would: a row whose last sync is newer than the event
            // is not a hit.
            updateMany: vi.fn(async ({ where, data }: { where: { stripeCustomerId: string; syncedAt?: { lte: Date } }; data: Partial<PlanRow> }) => {
                const hits = plans.filter(
                    (plan) =>
                        plan.stripeCustomerId === where.stripeCustomerId &&
                        (where.syncedAt === undefined || plan.syncedAt === undefined || plan.syncedAt <= where.syncedAt.lte),
                );
                for (const hit of hits) {
                    Object.assign(hit, data);
                }
                return { count: hits.length };
            }),
        },
    };
    return { prisma: prisma as unknown as PrismaClient, plans };
};

const row = (status: string, over: Partial<PlanRow> = {}): PlanRow => ({
    userId: `user-1`,
    stripeCustomerId: `cus_1`,
    stripeSubscriptionId: `sub_1`,
    status,
    currentPeriodEnd: NOW,
    ...over,
});

// A subscription as the gateway answers it, one slot, not cancelling.
const subscription = (over: Record<string, unknown> = {}) => ({
    id: `sub_9`,
    customer: `cus_9`,
    status: `active`,
    currentPeriodEnd: NOW,
    cancelAtPeriodEnd: false,
    itemId: `si_9`,
    quantity: 1,
    ...over,
});

const signed = (payload: string) => {
    const timestamp = Math.floor(NOW.getTime() / 1000);
    const signature = createHmac(`sha256`, `whsec_test`).update(`${timestamp}.${payload}`).digest(`hex`);
    return { "stripe-signature": `t=${timestamp},v1=${signature}` };
};

describe(`the hosted plan`, () => {
    it(`is on only for a paid, current row`, async () => {
        expect(await onHostedPlan(fakePrisma({ plans: [row(`active`)] }).prisma, baseConfig, `user-1`)).toBe(true);
        expect(await onHostedPlan(fakePrisma({ plans: [row(`trialing`)] }).prisma, baseConfig, `user-1`)).toBe(true);
        expect(await onHostedPlan(fakePrisma({ plans: [row(`past_due`)] }).prisma, baseConfig, `user-1`)).toBe(false);
        expect(await onHostedPlan(fakePrisma().prisma, baseConfig, `user-1`)).toBe(false);
    });

    it(`is on for an email on the comp list, with no row at all`, async () => {
        const comped = configWith({ compEmails: ` Dev@Example.com , other@example.com` });
        const { prisma } = fakePrisma({ users: [{ id: `user-1`, email: `dev@example.com` }] });
        expect(await onHostedPlan(prisma, comped, `user-1`)).toBe(true);
        // Off the list, back to the paid rule: nothing was ever written down.
        expect(await onHostedPlan(prisma, baseConfig, `user-1`)).toBe(false);
    });

    it(`does not exist on a platform that sells nothing`, async () => {
        const app = hostedPlanHttpRoutes({ config: configWith({ stripePriceId: `` }), prisma: fakePrisma().prisma, now: () => NOW });
        expect((await app.request(`/webhook`, { method: `POST`, body: `{}` })).status).toBe(404);
    });

    it(`refuses an unsigned webhook and honours a signed subscription lapse`, async () => {
        const { prisma, plans } = fakePrisma({ plans: [row(`active`)] });
        const gateway = { subscription: vi.fn() } as unknown as StripeGateway;
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        const payload = JSON.stringify({
            type: `customer.subscription.deleted`,
            data: { object: { id: `sub_1`, customer: `cus_1`, status: `canceled`, current_period_end: Math.floor(NOW.getTime() / 1000) } },
        });

        const unsigned = await app.request(`/webhook`, { method: `POST`, body: payload });
        expect(unsigned.status).toBe(400);
        expect(plans[0]?.status).toBe(`active`);

        const accepted = await app.request(`/webhook`, { method: `POST`, body: payload, headers: signed(payload) });
        expect(accepted.status).toBe(200);
        expect(plans[0]?.status).toBe(`canceled`);
    });

    it(`turns a signed completed checkout into a plan row, item and slot count included`, async () => {
        const { prisma, plans } = fakePrisma();
        const gateway = { subscription: vi.fn(async () => subscription({ quantity: 2 })) } as unknown as StripeGateway;
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        const payload = JSON.stringify({
            type: `checkout.session.completed`,
            data: { object: { mode: `subscription`, client_reference_id: `user-1`, subscription: `sub_9` } },
        });
        const response = await app.request(`/webhook`, { method: `POST`, body: payload, headers: signed(payload) });
        expect(response.status).toBe(200);
        expect(plans).toEqual([
            {
                userId: `user-1`,
                stripeCustomerId: `cus_9`,
                stripeSubscriptionId: `sub_9`,
                stripeItemId: `si_9`,
                status: `active`,
                currentPeriodEnd: NOW,
                cancelAtPeriodEnd: false,
                quantity: 2,
                syncedAt: expect.any(Date),
            },
        ]);
    });

    /* THE PORTAL'S CANCEL. Stripe keeps `status` active until the period ends and says so in
     * cancel_at_period_end; a mirror that did not read it told people who had just cancelled that they would
     * renew. */
    it(`mirrors a cancellation that has not ended yet`, async () => {
        const { prisma, plans } = fakePrisma({ plans: [row(`active`, { syncedAt: new Date(NOW.getTime() - 60_000) })] });
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, now: () => NOW });
        const payload = JSON.stringify({
            type: `customer.subscription.updated`,
            created: Math.floor(NOW.getTime() / 1000),
            data: {
                object: {
                    id: `sub_1`,
                    customer: `cus_1`,
                    status: `active`,
                    cancel_at_period_end: true,
                    current_period_end: Math.floor(NOW.getTime() / 1000),
                    items: { data: [{ id: `si_1`, quantity: 3 }] },
                },
            },
        });
        expect((await app.request(`/webhook`, { method: `POST`, body: payload, headers: signed(payload) })).status).toBe(200);
        expect(plans[0]).toMatchObject({ status: `active`, cancelAtPeriodEnd: true, quantity: 3, stripeItemId: `si_1` });
    });

    /* WEBHOOKS ARRIVE IN NO PARTICULAR ORDER. A cancel that landed a minute ago must not be undone by the
     * "active" event Stripe emitted a minute before it and delivered late. */
    it(`drops an event older than the state it last applied`, async () => {
        const { prisma, plans } = fakePrisma({ plans: [row(`canceled`, { syncedAt: NOW })] });
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, now: () => NOW });
        const payload = JSON.stringify({
            type: `customer.subscription.updated`,
            created: Math.floor(NOW.getTime() / 1000) - 120,
            data: { object: { id: `sub_1`, customer: `cus_1`, status: `active`, current_period_end: Math.floor(NOW.getTime() / 1000) } },
        });
        expect((await app.request(`/webhook`, { method: `POST`, body: payload, headers: signed(payload) })).status).toBe(200);
        expect(plans[0]?.status).toBe(`canceled`);
    });
});

/* A DELETED ACCOUNT'S SUBSCRIPTION ENDS WITH IT. Both deletions cascade the plan row; the Stripe subscription
 * is not a row of ours, and before this it kept charging a customer with no account left to open the portal
 * from. Called before the cascade, so the row still names the subscription. */
describe(`cancelling the plan with its account`, () => {
    it(`cancels a live subscription`, async () => {
        const gateway = { cancelSubscription: vi.fn(async () => subscription({ status: `canceled` })) } as unknown as StripeGateway;
        await cancelHostedPlan(fakePrisma({ plans: [row(`active`)] }).prisma, baseConfig, logger, `user-1`, gateway);
        expect(gateway.cancelSubscription).toHaveBeenCalledWith(`sub_1`);
    });

    it(`also ends one that is past due: Stripe is still trying to charge it`, async () => {
        const gateway = { cancelSubscription: vi.fn(async () => subscription({ status: `canceled` })) } as unknown as StripeGateway;
        await cancelHostedPlan(fakePrisma({ plans: [row(`past_due`)] }).prisma, baseConfig, logger, `user-1`, gateway);
        expect(gateway.cancelSubscription).toHaveBeenCalledTimes(1);
    });

    it(`has nothing to cancel for an account with no plan, an ended one, or a platform selling nothing`, async () => {
        const gateway = { cancelSubscription: vi.fn() } as unknown as StripeGateway;
        await cancelHostedPlan(fakePrisma().prisma, baseConfig, logger, `user-1`, gateway);
        await cancelHostedPlan(fakePrisma({ plans: [row(`canceled`)] }).prisma, baseConfig, logger, `user-1`, gateway);
        await cancelHostedPlan(fakePrisma({ plans: [row(`active`)] }).prisma, configWith({ stripePriceId: `` }), logger, `user-1`, gateway);
        expect(gateway.cancelSubscription).not.toHaveBeenCalled();
    });

    // An erasure must not be held hostage by a payment API; the log line is what names the manual cancel.
    it(`lets the deletion proceed when Stripe refuses, and says so at error level`, async () => {
        const gateway = { cancelSubscription: vi.fn(async () => { throw new Error(`Stripe refused: down`); }) } as unknown as StripeGateway;
        const errors = vi.fn();
        await cancelHostedPlan(fakePrisma({ plans: [row(`active`)] }).prisma, baseConfig, { info: vi.fn(), error: errors } as never, `user-1`, gateway);
        expect(errors).toHaveBeenCalledWith(expect.objectContaining({ subscription: `sub_1` }), expect.stringContaining(`by hand`));
    });
});

/* SLOTS: how many hosted sandboxes an account may have. The plan's quantity while it is live, the free lane's
 * one otherwise, and never fewer than the free lane gives. */
describe(`hosted slots`, () => {
    const config = { ...baseConfig, hosted: { ...baseConfig.hosted, perUser: 1 } };

    it(`is the plan's quantity while the plan is live`, async () => {
        expect(await hostedSlotsOf(fakePrisma({ plans: [row(`active`, { quantity: 3 })] }).prisma, config, `user-1`)).toBe(3);
    });

    it(`falls back to the free lane's one for a lapsed plan, no plan, and a comped account`, async () => {
        expect(await hostedSlotsOf(fakePrisma({ plans: [row(`past_due`, { quantity: 3 })] }).prisma, config, `user-1`)).toBe(1);
        expect(await hostedSlotsOf(fakePrisma().prisma, config, `user-1`)).toBe(1);
    });

    it(`never gives a subscriber fewer than the free lane does`, async () => {
        const generous = { ...config, hosted: { ...config.hosted, perUser: 2 } };
        expect(await hostedSlotsOf(fakePrisma({ plans: [row(`active`, { quantity: 1 })] }).prisma, generous, `user-1`)).toBe(2);
    });
});
