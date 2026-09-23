import { createHmac } from "node:crypto";
import { FREE_TIER, type HostedTier, PAID_TIERS } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import { configSchema, type Config } from "../../config.js";
import { call } from "@orpc/server";
import type { OrpcContext } from "../../context.js";
import { cancelHostedPlan, checkHostedPlanPrices, hostedSlotsOf, onHostedPlan } from "./hosted-plan.js";
import { StripeError, type StripeGateway, type StripePrice } from "./hosted-plan-stripe.js";
import { hostedPlanRoutes } from "./hosted-plan.orpc.js";
import { hostedPlanHttpRoutes } from "./hosted-plan.routes.js";

// Pins what a buyer would call betrayal if it drifted: on-plan means a paid row or the comp list, the webhook never
// rolls the mirror back, a deleted account's subscription ends with it, and slots equal the plan's quantity.

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;

const NOW = new Date(`2026-09-06T12:00:00Z`);

// Every paid rung on sale, at a price id named after it, derived from the ladder so a fourth rung is priced here
// without this file being edited. Transcribing the pairs would make the boot check's "unsold rung" warning fire in
// tests that are about something else.
const PRICE_IDS = new Map(PAID_TIERS.map((tier) => [`price_${tier.id}`, tier]));
const STRIPE_PRICES = [...PRICE_IDS].map(([priceId, tier]) => `${tier.id}=${priceId}`).join(`,`);
const ENTRY = PAID_TIERS[0] as HostedTier;

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
    hostedPlan: { stripeSecretKey: `sk_test`, stripeWebhookSecret: `whsec_test`, stripePrices: STRIPE_PRICES },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

const configWith = (hostedPlan: Partial<Config[`hostedPlan`]>): Config => ({
    ...baseConfig,
    hostedPlan: { ...baseConfig.hostedPlan, ...hostedPlan },
});

interface ItemRow {
    tier: string;
    stripeItemId: string;
    quantity: number;
}

interface PlanRow {
    id?: string;
    userId: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    status: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd?: boolean;
    items: ItemRow[];
    syncedAt?: Date;
}

// Enough Prisma for the plan: the user lookup the comp list needs, the plan reads/writes the webhook makes, and the
// per-rung slot rows it writes beside them.
const fakePrisma = (seed?: { plans?: PlanRow[]; users?: { id: string; email: string }[] }) => {
    const plans = seed?.plans ?? [];
    const users = seed?.users ?? [];
    const planById = (id: string) => plans.find((plan) => (plan.id ?? `plan-1`) === id);
    const prisma = {
        user: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => users.find((user) => user.id === where.id) ?? null) },
        hostedPlan: {
            findUnique: jest.fn(
                async ({ where }: { where: { userId?: string; stripeSubscriptionId?: string } }) =>
                    plans.find((plan) =>
                        where.userId === undefined ? plan.stripeSubscriptionId === where.stripeSubscriptionId : plan.userId === where.userId,
                    ) ?? null,
            ),
            upsert: jest.fn(async ({ where, create, update }: { where: { userId: string }; create: PlanRow; update: Partial<PlanRow> }) => {
                const existing = plans.find((plan) => plan.userId === where.userId);
                if (existing === undefined) {
                    const made: PlanRow = { id: `plan-1`, ...create, items: create.items ?? [] };
                    plans.push(made);
                    return made;
                }
                Object.assign(existing, update);
                return existing;
            }),
            // Honors the ordering guard like Postgres would: a row synced later than the event is not a hit.
            updateMany: jest.fn(async ({ where, data }: { where: { stripeCustomerId: string; syncedAt?: { lte: Date } }; data: Partial<PlanRow> }) => {
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
        hostedPlanItem: {
            upsert: jest.fn(
                async ({
                    where,
                    create,
                    update,
                }: {
                    where: { planId_tier: { planId: string; tier: string } };
                    create: ItemRow;
                    update: Partial<ItemRow>;
                }) => {
                    const plan = planById(where.planId_tier.planId);
                    const existing = plan?.items.find((item) => item.tier === where.planId_tier.tier);
                    if (existing === undefined) {
                        plan?.items.push({ tier: create.tier, stripeItemId: create.stripeItemId, quantity: create.quantity });
                        return create;
                    }
                    Object.assign(existing, update);
                    return existing;
                },
            ),
            deleteMany: jest.fn(async ({ where }: { where: { planId: string; tier: { notIn: string[] } } }) => {
                const plan = planById(where.planId);
                if (plan !== undefined) {
                    plan.items = plan.items.filter((item) => where.tier.notIn.includes(item.tier));
                }
                return { count: 0 };
            }),
        },
    };
    return { prisma: prisma as unknown as PrismaClient, plans };
};

const row = (status: string, over: Partial<PlanRow> = {}): PlanRow => ({
    id: `plan-1`,
    userId: `user-1`,
    stripeCustomerId: `cus_1`,
    stripeSubscriptionId: `sub_1`,
    status,
    currentPeriodEnd: NOW,
    items: [],
    ...over,
});

// A subscription as the gateway answers it: one slot at the entry rung, not cancelling.
const subscription = (over: Record<string, unknown> = {}) => ({
    id: `sub_9`,
    customer: `cus_9`,
    status: `active`,
    currentPeriodEnd: NOW,
    cancelAtPeriodEnd: false,
    items: [{ id: `si_9`, priceId: `price_${ENTRY.id}`, quantity: 1 }],
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
        // Off the list: falls back to the paid rules, with nothing ever written down.
        expect(await onHostedPlan(prisma, baseConfig, `user-1`)).toBe(false);
    });

    it(`does not exist on a platform that sells nothing`, async () => {
        const app = hostedPlanHttpRoutes({ config: configWith({ stripePrices: `` }), prisma: fakePrisma().prisma, now: () => NOW });
        expect((await app.request(`/webhook`, { method: `POST`, body: `{}` })).status).toBe(404);
    });

    it(`refuses an unsigned webhook and honours a signed subscription lapse, read fresh off Stripe`, async () => {
        const { prisma, plans } = fakePrisma({ plans: [row(`active`)] });
        const gateway = {
            subscription: jest.fn(async () => subscription({ id: `sub_1`, customer: `cus_1`, status: `canceled` })),
        } as unknown as StripeGateway;
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        const payload = JSON.stringify({
            type: `customer.subscription.deleted`,
            data: { object: { id: `sub_1`, object: `subscription`, customer: `cus_1`, status: `canceled` } },
        });

        const unsigned = await app.request(`/webhook`, { method: `POST`, body: payload });
        expect(unsigned.status).toBe(400);
        expect(plans[0]?.status).toBe(`active`);
        expect(gateway.subscription).not.toHaveBeenCalled();

        const accepted = await app.request(`/webhook`, { method: `POST`, body: payload, headers: signed(payload) });
        expect(accepted.status).toBe(200);
        expect(gateway.subscription).toHaveBeenCalledTimes(1);
        expect(gateway.subscription).toHaveBeenCalledWith(`sub_1`);
        expect(plans[0]?.status).toBe(`canceled`);
    });

    it(`turns a signed completed checkout into a plan row and a slot row for every rung it bought`, async () => {
        const { prisma, plans } = fakePrisma();
        const bought = [
            { id: `si_9`, priceId: `price_${ENTRY.id}`, quantity: 2 },
            { id: `si_10`, priceId: `price_max`, quantity: 1 },
        ];
        const gateway = { subscription: jest.fn(async () => subscription({ items: bought })) } as unknown as StripeGateway;
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        const payload = JSON.stringify({
            type: `checkout.session.completed`,
            data: { object: { mode: `subscription`, client_reference_id: `user-1`, subscription: `sub_9` } },
        });
        const response = await app.request(`/webhook`, { method: `POST`, body: payload, headers: signed(payload) });
        expect(response.status).toBe(200);
        expect(plans).toEqual([
            {
                id: `plan-1`,
                userId: `user-1`,
                stripeCustomerId: `cus_9`,
                stripeSubscriptionId: `sub_9`,
                status: `active`,
                currentPeriodEnd: NOW,
                cancelAtPeriodEnd: false,
                // The rung each item's price belongs to, which is how a slot knows what it is a slot of.
                items: [
                    { tier: ENTRY.id, stripeItemId: `si_9`, quantity: 2 },
                    { tier: `max`, stripeItemId: `si_10`, quantity: 1 },
                ],
                syncedAt: expect.any(Date),
            },
        ]);
    });

    // A price this platform does not sell names no rung, so it buys no slot rather than an unnamed one.
    it(`writes no slot for an item whose price belongs to no rung of this ladder`, async () => {
        const { prisma, plans } = fakePrisma();
        const gateway = {
            subscription: jest.fn(async () => subscription({ items: [{ id: `si_x`, priceId: `price_somebody_elses`, quantity: 4 }] })),
        } as unknown as StripeGateway;
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        const payload = JSON.stringify({
            type: `checkout.session.completed`,
            data: { object: { mode: `subscription`, client_reference_id: `user-1`, subscription: `sub_9` } },
        });
        await app.request(`/webhook`, { method: `POST`, body: payload, headers: signed(payload) });
        expect(plans[0]?.items).toEqual([]);
    });

    // Stripe keeps status active until the period ends; cancel_at_period_end is what says otherwise.
    it(`mirrors a cancellation that has not ended yet`, async () => {
        const { prisma, plans } = fakePrisma({ plans: [row(`active`, { syncedAt: new Date(NOW.getTime() - 60_000) })] });
        const gateway = {
            subscription: jest.fn(async () =>
                subscription({
                    id: `sub_1`,
                    customer: `cus_1`,
                    status: `active`,
                    cancelAtPeriodEnd: true,
                    items: [{ id: `si_1`, priceId: `price_${ENTRY.id}`, quantity: 3 }],
                }),
            ),
        } as unknown as StripeGateway;
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        // The event's own copy is trimmed to nothing useful; state comes from the fresh read.
        const payload = JSON.stringify({ type: `customer.subscription.updated`, data: { object: { id: `sub_1`, object: `subscription` } } });
        expect((await app.request(`/webhook`, { method: `POST`, body: payload, headers: signed(payload) })).status).toBe(200);
        expect(plans[0]).toMatchObject({ status: `active`, cancelAtPeriodEnd: true, syncedAt: NOW });
        expect(plans[0]?.items).toEqual([{ tier: ENTRY.id, stripeItemId: `si_1`, quantity: 3 }]);
    });

    it(`never rolls the mirror back: the event's copy is not trusted, and a read older than the row is dropped`, async () => {
        const { prisma, plans } = fakePrisma({ plans: [row(`canceled`, { syncedAt: NOW })] });
        const gateway = {
            subscription: jest.fn(async () => subscription({ id: `sub_1`, customer: `cus_1`, status: `canceled` })),
        } as unknown as StripeGateway;
        // The late event still says active; what Stripe says now is what gets written.
        const late = JSON.stringify({
            type: `customer.subscription.updated`,
            data: { object: { id: `sub_1`, object: `subscription`, status: `active` } },
        });
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        expect((await app.request(`/webhook`, { method: `POST`, body: late, headers: signed(late) })).status).toBe(200);
        expect(plans[0]?.status).toBe(`canceled`);

        // A read two minutes older than the row's last write (a slower, racing handler): stale by construction,
        // dropped.
        const active = {
            subscription: jest.fn(async () => subscription({ id: `sub_1`, customer: `cus_1`, status: `active` })),
        } as unknown as StripeGateway;
        const slower = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway: active, now: () => new Date(NOW.getTime() - 120_000) });
        expect((await slower.request(`/webhook`, { method: `POST`, body: late, headers: signed(late) })).status).toBe(200);
        expect(plans[0]?.status).toBe(`canceled`);

        // The same read, now a moment newer than the row: applied.
        const newer = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway: active, now: () => new Date(NOW.getTime() + 1) });
        expect((await newer.request(`/webhook`, { method: `POST`, body: late, headers: signed(late) })).status).toBe(200);
        expect(plans[0]?.status).toBe(`active`);
    });

    it(`acknowledges an event whose object is not a subscription without asking Stripe anything`, async () => {
        const { prisma, plans } = fakePrisma({ plans: [row(`active`)] });
        const gateway = { subscription: jest.fn() } as unknown as StripeGateway;
        const app = hostedPlanHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        const payload = JSON.stringify({ type: `customer.subscription.updated`, data: { object: { id: `in_1`, object: `invoice` } } });
        expect((await app.request(`/webhook`, { method: `POST`, body: payload, headers: signed(payload) })).status).toBe(200);
        expect(gateway.subscription).not.toHaveBeenCalled();
        expect(plans[0]?.status).toBe(`active`);
    });
});

// Both deletions cascade the plan row, but the Stripe subscription doesn't cancel itself with it; called before the
// cascade, while the row still names the subscription.
describe(`cancelling the plan with its account`, () => {
    it(`cancels a live subscription`, async () => {
        const gateway = { cancelSubscription: jest.fn(async () => subscription({ status: `canceled` })) } as unknown as StripeGateway;
        await cancelHostedPlan(fakePrisma({ plans: [row(`active`)] }).prisma, baseConfig, logger, `user-1`, gateway);
        expect(gateway.cancelSubscription).toHaveBeenCalledWith(`sub_1`);
    });

    it(`also ends one that is past due: Stripe is still trying to charge it`, async () => {
        const gateway = { cancelSubscription: jest.fn(async () => subscription({ status: `canceled` })) } as unknown as StripeGateway;
        await cancelHostedPlan(fakePrisma({ plans: [row(`past_due`)] }).prisma, baseConfig, logger, `user-1`, gateway);
        expect(gateway.cancelSubscription).toHaveBeenCalledTimes(1);
    });

    it(`has nothing to cancel for an account with no plan, an ended one, or a platform selling nothing`, async () => {
        const gateway = { cancelSubscription: jest.fn() } as unknown as StripeGateway;
        await cancelHostedPlan(fakePrisma().prisma, baseConfig, logger, `user-1`, gateway);
        await cancelHostedPlan(fakePrisma({ plans: [row(`canceled`)] }).prisma, baseConfig, logger, `user-1`, gateway);
        await cancelHostedPlan(fakePrisma({ plans: [row(`active`)] }).prisma, configWith({ stripePrices: `` }), logger, `user-1`, gateway);
        expect(gateway.cancelSubscription).not.toHaveBeenCalled();
    });

    // An erasure must not be held hostage by a payment API; the log line names the manual follow-up.
    it(`lets the deletion proceed when Stripe refuses, and says so at error level`, async () => {
        const gateway = {
            cancelSubscription: jest.fn(async () => {
                throw new Error(`Stripe refused: down`);
            }),
        } as unknown as StripeGateway;
        const errors = jest.fn();
        await cancelHostedPlan(
            fakePrisma({ plans: [row(`active`)] }).prisma,
            baseConfig,
            { info: jest.fn(), error: errors } as never,
            `user-1`,
            gateway,
        );
        expect(errors).toHaveBeenCalledWith(expect.objectContaining({ subscription: `sub_1` }), expect.stringContaining(`by hand`));
    });
});

// A price nobody can buy is otherwise found by the first buyer, as a 500 on checkout and no word anywhere else; this is
// the boot read that says so first, in the terms an operator can act on.
describe(`the price the plan sells`, () => {
    // A rung's price exactly as the ladder advertises it, so the "charges something else" test is the only one that
    // disagrees on purpose. Read from the tier rather than typed, since the ladder is what the check compares against.
    const price = (tier: HostedTier, over: Partial<StripePrice> = {}): StripePrice => ({
        active: true,
        livemode: true,
        unitAmount: Math.round(tier.priceUsd * 100),
        currency: `usd`,
        interval: `month`,
        ...over,
    });

    const logs = () => {
        const spies = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        return { ...spies, logger: spies as never };
    };

    // Answers for whichever rung's price is asked about; one override applies to every rung, which is what each fault
    // test means. A price id off the ladder is a mistake in the test, not a case to answer.
    const answering = (over: Partial<StripePrice> | Error = {}): StripeGateway =>
        ({
            price: jest.fn(async (priceId: string) => {
                if (over instanceof Error) {
                    throw over;
                }
                const tier = PRICE_IDS.get(priceId);
                if (tier === undefined) {
                    throw new Error(`the boot check asked about ${priceId}, which is not a rung's price`);
                }
                return price(tier, over);
            }),
        }) as unknown as StripeGateway;

    it(`asks nothing of Stripe on a platform that sells nothing`, async () => {
        const gateway = answering();
        const log = logs();
        await checkHostedPlanPrices(configWith({ stripePrices: `` }), log.logger, gateway);
        expect(gateway.price).not.toHaveBeenCalled();
        expect([log.error, log.warn, log.info].every((spy) => spy.mock.calls.length === 0)).toBe(true);
    });

    // A rung with no price is not a fault, it is a rung nobody can buy; the warning is what says which.
    it(`names the rungs that have no price at all, and still sells the ones that do`, async () => {
        const log = logs();
        await checkHostedPlanPrices(configWith({ stripePrices: `${ENTRY.id}=price_${ENTRY.id}` }), log.logger, answering());
        const unsold = PAID_TIERS.filter((tier) => tier.id !== ENTRY.id).map((tier) => tier.id);
        expect(log.warn).toHaveBeenCalledWith({ unsold }, expect.stringContaining(`cannot be bought`));
        expect(log.error).not.toHaveBeenCalled();
    });

    it(`says an archived price cannot be sold, naming the price and its rung`, async () => {
        const log = logs();
        await checkHostedPlanPrices(baseConfig, log.logger, answering({ active: false }));
        expect(log.error).toHaveBeenCalledWith(
            expect.objectContaining({ tier: ENTRY.id, priceId: `price_${ENTRY.id}` }),
            expect.stringContaining(`archived`),
        );
    });

    it(`says a one-off price cannot be sold in subscription mode`, async () => {
        const log = logs();
        await checkHostedPlanPrices(baseConfig, log.logger, answering({ interval: `` }));
        expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(`subscription mode`));
    });

    // The ladder's number is display only, so a price charging something else is a lie nothing else would catch.
    it(`says so when Stripe charges something other than the rung's advertised price`, async () => {
        const log = logs();
        await checkHostedPlanPrices(baseConfig, log.logger, answering({ unitAmount: 599 }));
        expect(log.error).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining(`5.99 USD, while the ladder advertises ${ENTRY.priceUsd.toFixed(2)} USD`),
        );
    });

    it(`keeps Stripe's own words when it refuses the read, and does not throw`, async () => {
        const log = logs();
        await checkHostedPlanPrices(baseConfig, log.logger, answering(new Error(`Stripe refused: No such price: 'price_1'`)));
        expect(log.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.objectContaining({ message: expect.stringContaining(`No such price`) }) }),
            expect.stringContaining(`nobody can buy it`),
        );
    });

    it(`warns that a test-mode price charges nobody, and stays quiet about a live one`, async () => {
        const testMode = logs();
        await checkHostedPlanPrices(baseConfig, testMode.logger, answering({ livemode: false }));
        expect(testMode.error).not.toHaveBeenCalled();
        expect(testMode.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(`TEST-mode`));

        const live = logs();
        await checkHostedPlanPrices(baseConfig, live.logger, answering());
        expect(live.error).not.toHaveBeenCalled();
        expect(live.warn).not.toHaveBeenCalled();
        // Every rung on the ladder is sold, and each says so by name.
        expect(live.info).toHaveBeenCalledTimes(PAID_TIERS.length);
        expect(live.info).toHaveBeenCalledWith(
            { tier: ENTRY.id, priceId: `price_${ENTRY.id}` },
            `hosted plan: selling ${ENTRY.id} (price_${ENTRY.id}) at ${ENTRY.priceUsd.toFixed(2)} USD per month`,
        );
    });
});

// What the buyer is told when Stripe says no: the refusal's own words with a gateway code, because an unhandled throw
// here is a 500 the Billing page can only render as "couldn't open the payment page".
describe(`the doors to Stripe`, () => {
    const contextFor = (prisma: PrismaClient): OrpcContext =>
        ({ prisma, config: baseConfig, user: { id: `user-1`, email: `buyer@intentic.dev` }, logger }) as unknown as OrpcContext;

    it(`answers a refused checkout with Stripe's reason, not an unhandled error`, async () => {
        const refusing = {
            checkoutSession: jest.fn(async () => {
                throw new StripeError(`Stripe refused: The price specified is inactive. This field only accepts active prices.`);
            }),
        } as unknown as StripeGateway;
        await expect(call(hostedPlanRoutes(refusing).checkout, {}, { context: contextFor(fakePrisma().prisma) })).rejects.toMatchObject({
            code: `BAD_GATEWAY`,
            message: `Stripe refused: The price specified is inactive. This field only accepts active prices.`,
        });
    });

    it(`answers a refused portal the same way`, async () => {
        const refusing = {
            portalSession: jest.fn(async () => {
                throw new StripeError(`Stripe refused: No configuration provided`);
            }),
        } as unknown as StripeGateway;
        const { prisma } = fakePrisma({ plans: [row(`active`)] });
        await expect(call(hostedPlanRoutes(refusing).portal, {}, { context: contextFor(prisma) })).rejects.toMatchObject({
            code: `BAD_GATEWAY`,
            message: `Stripe refused: No configuration provided`,
        });
    });
});

// Slots are per rung and the free one is never bought, so paying for a Standard never takes away the free machine.
describe(`hosted slots`, () => {
    const config = { ...baseConfig, hosted: { ...baseConfig.hosted, perUser: 1 } };
    const item = (tier: string, quantity: number) => ({ tier, quantity, stripeItemId: `si_${tier}` });

    it.each([
        [
            `adds each rung's bought slots to the free plan's own`,
            [row(`active`, { items: [item(ENTRY.id, 2), item(`max`, 1)] })],
            { free: 1, [ENTRY.id]: 2, max: 1 },
        ],
        [`counts no bought slot for a lapsed plan`, [row(`past_due`, { items: [item(ENTRY.id, 3)] })], { free: 1 }],
        [`gives the free plan's with no plan at all`, [], { free: 1 }],
        [`never sells a slot at the free rung, whatever an item says`, [row(`active`, { items: [item(FREE_TIER.id, 9)] })], { free: 1 }],
    ])(`%s`, async (_name, plans, expected) => {
        expect(Object.fromEntries(await hostedSlotsOf(fakePrisma({ plans }).prisma, config, `user-1`))).toEqual(expected);
    });
});
