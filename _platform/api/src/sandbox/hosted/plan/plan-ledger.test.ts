import { FREE_TIER, PAID_TIERS, type HostedTier } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import { unstubbed } from "@intentic/testing";
import { configSchema } from "../../../config.js";
import type { StripeGateway, StripeSubscription } from "./hosted-plan-stripe.js";
import { decidePlanChange } from "./plan-change.js";
import { carryOutPlanChange, PlanRefused } from "./plan-ledger.js";

// What reaches Stripe for a decision: the exact items, proration and renewal-date end, and the row written after it.

const NOW = new Date(`2026-11-26T12:00:00Z`);
const RENEWAL = new Date(`2026-12-26T12:00:00Z`);
const paidRung = (index: number): HostedTier => {
    const tier = PAID_TIERS[index];
    if (tier === undefined) {
        throw new Error(`these tests need a ladder with two paid rungs`);
    }
    return tier;
};
const STANDARD = paidRung(0);
const MAX = paidRung(1);

const config = configSchema.parse({
    database: { url: `postgres://x` },
    betterAuth: { secret: `s` },
    webOrigin: `https://app.test`,
    hosted: { perUser: 1 },
    hostedPlan: { stripeSecretKey: `sk_test`, stripePrices: PAID_TIERS.map((tier) => `${tier.id}=price_${tier.id}`).join(`,`) },
});

interface Machine {
    sandboxId: string;
    tier: string;
    paid: boolean;
    planTo: string | null;
    planAt: Date | null;
}

// One owner with a live subscription holding `items`, and these sandboxes; every write lands on the arrays.
const ledger = (items: { tier: string; quantity: number }[], machines: Machine[], cancelAtPeriodEnd = false) => {
    const plan = {
        id: `plan-1`,
        userId: `u1`,
        stripeCustomerId: `cus_1`,
        stripeSubscriptionId: `sub_1`,
        status: `active`,
        currentPeriodEnd: RENEWAL,
        cancelAtPeriodEnd,
        items: items.map((item) => ({ ...item, stripeItemId: `si_${item.tier}` })),
    };
    const updates: { where: { sandboxId: string }; data: Partial<Machine> }[] = [];
    const client = {
        $executeRaw: jest.fn(async () => 0),
        user: { findUnique: jest.fn(async () => ({ email: `owner@example.com` })) },
        hostedPlan: {
            findUnique: jest.fn(async () => plan),
            upsert: jest.fn(async () => plan),
        },
        hostedPlanItem: { upsert: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({ count: 0 })) },
        hostedMachine: {
            findMany: jest.fn(async () => machines.map((machine) => ({ ...machine, sandbox: { name: machine.sandboxId } }))),
            update: jest.fn(async (args: { where: { sandboxId: string }; data: Partial<Machine> }) => {
                updates.push(args);
                return {};
            }),
            updateMany: jest.fn(async () => ({ count: 0 })),
        },
    };
    const transaction = jest.fn(async (work: (tx: typeof client) => Promise<object>) => work(client));
    // SAFETY: a fake of exactly the delegates the ledger reads and writes (the plan, its items, the machines, the user
    // and the lock), its transaction running the callback on that same fake; any other member throws by name.
    const prisma = unstubbed<PrismaClient>(`prisma`, { ...client, $transaction: transaction } as never);
    return { prisma, updates };
};

const answered: StripeSubscription = { id: `sub_1`, customer: `cus_1`, status: `active`, currentPeriodEnd: RENEWAL, cancelAtPeriodEnd: false, items: [] };

const machine = (sandboxId: string, tier: string, extra: Partial<Machine> = {}): Machine => ({
    sandboxId,
    tier,
    paid: tier !== FREE_TIER.id,
    planTo: null,
    planAt: null,
    ...extra,
});

describe(`carrying out a plan change`, () => {
    it(`upgrades by raising the tier's quantity, prorated, then marks the sandbox paid with its resize due`, async () => {
        const setItems = jest.fn<StripeGateway[`setItems`]>(async () => answered);
        const { prisma, updates } = ledger([{ tier: STANDARD.id, quantity: 1 }], [machine(`a`, STANDARD.id), machine(`b`, FREE_TIER.id)]);
        await carryOutPlanChange(prisma, config, unstubbed<StripeGateway>(`stripe`, { setItems }), `u1`, `b`, (read) =>
            decidePlanChange(read.account, read.machines, `b`, STANDARD.id, NOW),
        );
        expect(setItems.mock.calls).toEqual([
            [`sub_1`, [{ itemId: `si_${STANDARD.id}`, priceId: `price_${STANDARD.id}`, quantity: 2 }], { proration: `create_prorations`, cancelAtPeriodEnd: false }],
        ]);
        expect(updates).toEqual([{ where: { sandboxId: `b` }, data: { paid: true, planTo: STANDARD.id, planAt: NOW } }]);
    });

    it(`adds an item for a tier the subscription does not carry yet, and deletes one a downgrade empties`, async () => {
        const setItems = jest.fn<StripeGateway[`setItems`]>(async () => answered);
        const { prisma } = ledger([{ tier: MAX.id, quantity: 1 }, { tier: STANDARD.id, quantity: 1 }], [machine(`a`, MAX.id), machine(`b`, STANDARD.id)]);
        await carryOutPlanChange(prisma, config, unstubbed<StripeGateway>(`stripe`, { setItems }), `u1`, `a`, (read) =>
            decidePlanChange(read.account, read.machines, `a`, STANDARD.id, NOW),
        );
        expect(setItems.mock.calls).toEqual([
            [
                `sub_1`,
                [
                    { itemId: `si_${MAX.id}`, priceId: `price_${MAX.id}`, quantity: 0 },
                    { itemId: `si_${STANDARD.id}`, priceId: `price_${STANDARD.id}`, quantity: 2 },
                ],
                { proration: `none`, cancelAtPeriodEnd: false },
            ],
        ]);
    });

    it(`ends the subscription at renewal, touching no item, when the last paid sandbox is scheduled to Free`, async () => {
        const setItems = jest.fn<StripeGateway[`setItems`]>(async () => answered);
        const { prisma, updates } = ledger([{ tier: STANDARD.id, quantity: 1 }], [machine(`a`, STANDARD.id)]);
        await carryOutPlanChange(prisma, config, unstubbed<StripeGateway>(`stripe`, { setItems }), `u1`, `a`, (read) =>
            decidePlanChange(read.account, read.machines, `a`, FREE_TIER.id, NOW),
        );
        expect(setItems.mock.calls).toEqual([[`sub_1`, [], { proration: `none`, cancelAtPeriodEnd: true }]]);
        expect(updates).toEqual([{ where: { sandboxId: `a` }, data: { paid: true, planTo: FREE_TIER.id, planAt: RENEWAL } }]);
    });

    it(`writes nothing at all for a refusal`, async () => {
        const setItems = jest.fn<StripeGateway[`setItems`]>(async () => answered);
        const { prisma, updates } = ledger([{ tier: STANDARD.id, quantity: 1 }], [machine(`a`, STANDARD.id)]);
        await expect(
            carryOutPlanChange(prisma, config, unstubbed<StripeGateway>(`stripe`, { setItems }), `u1`, `a`, (read) =>
                decidePlanChange(read.account, read.machines, `a`, STANDARD.id, NOW),
            ),
        ).rejects.toBeInstanceOf(PlanRefused);
        expect({ stripe: setItems.mock.calls.length, rows: updates.length }).toEqual({ stripe: 0, rows: 0 });
    });
});
