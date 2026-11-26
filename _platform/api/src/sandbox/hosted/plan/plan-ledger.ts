import { isHostedTierId } from "@intentic/constants";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import type { Config } from "../../../config.js";
import { applySubscription, hostedPrices, isComped, isLiveSubscription, isOnPlan } from "./hosted-plan.js";
import type { StripeGateway } from "./hosted-plan-stripe.js";
import type { PlanAccount, PlanDecision, PlanMachine, SeatWrite } from "./plan-change.js";

/* CARRIES OUT A PLAN DECISION (plan-change.ts decides it): reads the owner's ledger, writes the subscription, then the
 * sandbox's row, under the owner's lock so two presses cannot both read the same quantities. Stripe is written first:
 * a row that failed to follow leaves a plan with no sandbox on it, which Billing shows and asks about, where the other
 * order would leave a sandbox on a plan nobody is billed for. */

type Client = PrismaClient | Prisma.TransactionClient;

const planRowOf = (prisma: Client, userId: string) => prisma.hostedPlan.findUnique({ where: { userId }, include: { items: true } });

type PlanRow = NonNullable<Awaited<ReturnType<typeof planRowOf>>>;

/** Everything a decision reads about one owner: their billing, and every cloud sandbox of theirs as its plan sees it. */
export const planLedgerOf = async (prisma: Client, config: Config, userId: string): Promise<{ account: PlanAccount; machines: PlanMachine[] }> => {
    const [plan, rows] = await Promise.all([
        planRowOf(prisma, userId),
        prisma.hostedMachine.findMany({
            where: { sandbox: { ownerId: userId } },
            select: { sandboxId: true, tier: true, paid: true, planTo: true, planAt: true, sandbox: { select: { name: true } } },
            orderBy: [{ createdAt: `asc` }, { id: `asc` }],
        }),
    ]);
    // The comp list answers only for an account no subscription pays for, as the plan state reads it.
    const comped = !isOnPlan(plan) && (await isComped(prisma, config, userId));
    const base = { comped, freeAllowed: config.hosted.perUser, onSale: new Set(hostedPrices(config).keys()) };
    const account: PlanAccount =
        plan !== null && isLiveSubscription(plan)
            ? {
                  ...base,
                  subscription: {
                      active: isOnPlan(plan),
                      periodEnd: plan.currentPeriodEnd,
                      cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
                      quantities: new Map(plan.items.map((item) => [item.tier, item.quantity])),
                  },
              }
            : base;
    const machines = rows.map(({ sandbox, ...row }) => ({ ...row, name: sandbox.name }));
    return { account, machines };
};

const totalOf = (quantities: ReadonlyMap<string, number>): number => [...quantities.values()].reduce((sum, count) => sum + count, 0);

/* One write to Stripe and its mirror. All zero ends the subscription at the renewal date instead (Stripe is never asked
 * to hold an item at zero); otherwise every tier whose quantity moved, and every tier at all while the subscription was
 * set to end, since its quantities were left as they stood then. */
const writeSeats = async (prisma: PrismaClient, config: Config, stripe: StripeGateway, userId: string, plan: PlanRow, write: SeatWrite): Promise<void> => {
    if (totalOf(write.quantities) === 0) {
        const ended = await stripe.setItems(plan.stripeSubscriptionId, [], { proration: write.proration, cancelAtPeriodEnd: true });
        await applySubscription(prisma, config, ended, { userId });
        return;
    }
    const prices = hostedPrices(config);
    const items: { itemId?: string; priceId: string; quantity: number }[] = [];
    for (const [tier, quantity] of write.quantities) {
        const priceId = isHostedTierId(tier) ? prices.get(tier) : undefined;
        const existing = plan.items.find((item) => item.tier === tier);
        if (existing !== undefined && (existing.quantity !== quantity || plan.cancelAtPeriodEnd)) {
            items.push({ itemId: existing.stripeItemId, priceId: priceId ?? ``, quantity });
        } else if (existing === undefined && quantity > 0 && priceId !== undefined) {
            items.push({ priceId, quantity });
        }
    }
    const updated = await stripe.setItems(plan.stripeSubscriptionId, items, { proration: write.proration, cancelAtPeriodEnd: false });
    await applySubscription(prisma, config, updated, { userId });
};

/** A decision the routes refuse with, in the shape they throw it. */
export class PlanRefused extends Error {
    readonly code: Extract<PlanDecision, { kind: `refused` }>[`code`];

    constructor(decision: Extract<PlanDecision, { kind: `refused` }>) {
        super(decision.message);
        this.code = decision.code;
    }
}

/**
 * Decides and carries out one change for one owner, under the lock provisioning takes too (hosted.ts withHostedSlot),
 * so a plan reserved for a new sandbox and the sandbox landing on it are never read half-done. `sandboxId` is the row
 * the decision's `machine` is written to, if any. Answers the decision carried out; throws PlanRefused for a refusal.
 */
export const carryOutPlanChange = async (
    prisma: PrismaClient,
    config: Config,
    stripe: StripeGateway,
    userId: string,
    sandboxId: string | undefined,
    decide: (ledger: Awaited<ReturnType<typeof planLedgerOf>>) => PlanDecision,
): Promise<Extract<PlanDecision, { kind: `change` }>> =>
    prisma.$transaction(
        async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hosted-slot'), hashtext(${userId}))`;
            const decision = decide(await planLedgerOf(tx, config, userId));
            if (decision.kind === `refused`) {
                throw new PlanRefused(decision);
            }
            for (const write of decision.writes) {
                // Read fresh before each: the first write may have added the item the second one addresses.
                const plan = await planRowOf(prisma, userId);
                if (plan === null) {
                    throw new PlanRefused({ kind: `refused`, code: `checkout`, message: `pay for the first plan on Stripe's page` });
                }
                // one write per step, in order: each is prorated by its own rule
                await writeSeats(prisma, config, stripe, userId, plan, write);
            }
            if (sandboxId !== undefined) {
                await tx.hostedMachine.update({ where: { sandboxId }, data: decision.machine });
            }
            return decision;
        },
        // Stripe answers within its own 30 s timeout; the lock is held across it on purpose.
        { timeout: 90_000, maxWait: 30_000 },
    );
