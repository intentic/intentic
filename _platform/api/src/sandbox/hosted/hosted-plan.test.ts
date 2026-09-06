import { createHmac } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import { describe, expect, it, vi } from "vitest";
import { configSchema, type Config } from "../../config.js";
import { onHostedPlan } from "./hosted-plan.js";
import type { StripeGateway } from "./hosted-plan-stripe.js";
import { hostedPlanHttpRoutes } from "./hosted-plan.routes.js";

/* THE PLAN IS THE ONE THING SOLD, so what is pinned is what a buyer would call betrayal if it drifted: being
 * on the plan meaning a paid, current row (or the operator's own comp list) and nothing less, and the webhook
 * refusing an unsigned event while honouring a signed one. */

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
    status: string;
    currentPeriodEnd: Date;
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
            updateMany: vi.fn(async ({ where, data }: { where: { stripeCustomerId: string }; data: Partial<PlanRow> }) => {
                const hits = plans.filter((plan) => plan.stripeCustomerId === where.stripeCustomerId);
                for (const hit of hits) {
                    Object.assign(hit, data);
                }
                return { count: hits.length };
            }),
        },
    };
    return { prisma: prisma as unknown as PrismaClient, plans };
};

const row = (status: string): PlanRow => ({ userId: `user-1`, stripeCustomerId: `cus_1`, stripeSubscriptionId: `sub_1`, status, currentPeriodEnd: NOW });

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

    it(`turns a signed completed checkout into a plan row`, async () => {
        const { prisma, plans } = fakePrisma();
        const gateway = {
            subscription: vi.fn(async () => ({ id: `sub_9`, customer: `cus_9`, status: `active`, currentPeriodEnd: NOW })),
        } as unknown as StripeGateway;
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        const payload = JSON.stringify({
            type: `checkout.session.completed`,
            data: { object: { mode: `subscription`, client_reference_id: `user-1`, subscription: `sub_9` } },
        });
        const response = await app.request(`/webhook`, { method: `POST`, body: payload, headers: signed(payload) });
        expect(response.status).toBe(200);
        expect(plans).toEqual([{ userId: `user-1`, stripeCustomerId: `cus_9`, stripeSubscriptionId: `sub_9`, status: `active`, currentPeriodEnd: NOW }]);
    });
});
