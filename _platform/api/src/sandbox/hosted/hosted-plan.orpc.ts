import { apiContract, type HostedMigration as HostedMigrationState, type HostedPlanHosted, type HostedPlanState } from "@intentic/api-contract";
import { FREE_TIER, type HostedTier, hostedTier, isHostedTierId } from "@intentic/constants";
import { implement, ORPCError } from "@orpc/server";
import type { Config } from "../../config.js";
import type { OrpcContext } from "../../context.js";
import { requireUser } from "../../guards.js";
import { hostedEnabled } from "./hosted.js";
import { applySubscription, entryTier, hostedPlanEnabled, hostedPrices, hostedSlotsOf, isComped, isOnPlan, slotsAtTier } from "./hosted-plan.js";
import { HostedMigrationRefused, type MigrationRefusal, migrateHosted } from "./migrate/hosted-migrate.js";
import { StripeError, type StripeGateway, stripeGateway } from "./hosted-plan-stripe.js";
import { hostedShapeFor, shapeOfRow, tierOfRow } from "./hosted-shape.js";
import { hostedArrivalBudget, hostedBudgetOf, hostedOomsSince, usageMonth, usageResetsAt } from "./hosted-usage.js";
import { DAY_MS } from "../../durations.js";

const os = implement(apiContract).$context<OrpcContext>();

// Where Stripe sends the browser back: the Billing page, which owns the post-checkout wait and every state's words.
const billingUrl = (context: OrpcContext, query = ``): string => `${context.config.webOrigin}/settings/billing${query}`;

// The lane as it applies to one account: slots, machines, this month's meter, shared by the Billing page, avatar row
// and Overview card so they can't disagree. usedMinutes is live, shown to subscribers too; the ceiling (ramped for a
// new account, absent for a subscriber) is the budget's own answer, so the page and the wake cannot disagree.
const hostedFor = async (context: OrpcContext, userId: string): Promise<HostedPlanHosted> => {
    const { prisma, config } = context;
    const now = new Date();
    const [slots, machines, budget] = await Promise.all([
        hostedSlotsOf(prisma, config, userId),
        prisma.hostedMachine.findMany({
            where: { sandbox: { ownerId: userId } },
            select: {
                region: true,
                wokeAt: true,
                tier: true,
                cpuKind: true,
                cpus: true,
                memoryMb: true,
                volumeGb: true,
                sandbox: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: `asc` },
        }),
        hostedArrivalBudget(prisma, config, userId, now),
    ]);
    // Each machine's own month and its own week of out-of-memory kills; both are the machine's, not the account's.
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const meters = await Promise.all(
        machines.map(async (machine) =>
            Promise.all([
                hostedBudgetOf(prisma, config, { sandboxId: machine.sandbox.id, tier: machine.tier, ownerId: userId }, now),
                hostedOomsSince(prisma, machine.sandbox.id, weekAgo),
            ]),
        ),
    );
    return {
        slots: slots.total,
        slotsByTier: Object.fromEntries([[FREE_TIER.id, slots.free], ...slots.paid]),
        machines: machines.map((machine, index) => {
            const [meter, oomsThisWeek] = meters[index] as (typeof meters)[number];
            return {
                sandboxId: machine.sandbox.id,
                name: machine.sandbox.name,
                region: machine.region,
                wokeAt: machine.wokeAt?.toISOString() ?? null,
                tier: machine.tier,
                // The machine's own numbers, never the rung's: the two part company the moment a migration starts.
                shape: shapeOfRow(config, tierOfRow(machine.tier), machine),
                usedMinutes: meter.usedMinutes,
                allowanceMinutes: meter.metered ? meter.allowanceMinutes : null,
                oomsThisWeek,
            };
        }),
        usage: {
            month: usageMonth(now),
            usedMinutes: budget.usedMinutes,
            allowanceMinutes: budget.metered ? budget.allowanceMinutes : null,
            resetsAt: usageResetsAt(now).toISOString(),
            ...(budget.rampUntil === undefined ? {} : { rampUntil: budget.rampUntil.toISOString() }),
        },
        freeTier: {
            id: FREE_TIER.id,
            shape: hostedShapeFor(config, FREE_TIER.id),
            monthlyHours: config.hosted.monthlyHours,
        },
    };
};

// What every answer carries, signed in or not: whether this platform sells a machine at all, and what the cheapest
// rung costs. It rides even on a disabled answer, since it describes the offer to someone who has not bought it.
const planOffer = (config: Config): HostedPlanState => {
    const entry = entryTier(config);
    return { enabled: hostedPlanEnabled(config), onPlan: false, priceUsd: entry === undefined ? 0 : entry.tier.priceUsd };
};

// The whole answer, for `state` and every write that ends by re-reading it. Plan half from the mirror row and comp list
// (hosted-plan.ts owns the rule); hosted half from hostedFor above.
const hostedPlanStateOf = async (context: OrpcContext): Promise<HostedPlanState> => {
    const { config, prisma } = context;
    const base = planOffer(config);
    // Signed out: the page renders the offer; buying starts with the ordinary sign-in.
    if (context.user === null) {
        return base;
    }
    const plan = base.enabled ? await prisma.hostedPlan.findUnique({ where: { userId: context.user.id } }) : null;
    const paid = isOnPlan(plan);
    // The comp list answers only when no paid row does; a comped account that later pays becomes a subscriber first.
    const comped = !paid && base.enabled && (await isComped(prisma, config, context.user.id));
    const onPlan = paid || comped;
    return {
        ...base,
        onPlan,
        ...(comped ? { comped: true } : {}),
        ...(plan !== null
            ? { status: plan.status, renewsAt: plan.currentPeriodEnd.toISOString(), ...(plan.cancelAtPeriodEnd ? { cancelAtPeriodEnd: true } : {}) }
            : {}),
        ...(hostedEnabled(config) ? { hosted: await hostedFor(context, context.user.id) } : {}),
    };
};

const requirePlanEnabled = (context: OrpcContext): void => {
    if (!hostedPlanEnabled(context.config)) {
        throw new ORPCError(`NOT_FOUND`, { message: `the hosted plan is not enabled on this platform` });
    }
};

// Wire status per migration refusal: every one of them means nothing was spent (hosted-migrate.ts).
const MIGRATION_REFUSALS = {
    off: `NOT_FOUND`,
    "no-machine": `NOT_FOUND`,
    busy: `TOO_MANY_REQUESTS`,
    "nothing-to-do": `BAD_REQUEST`,
    "unknown-tier": `BAD_REQUEST`,
    capacity: `SERVICE_UNAVAILABLE`,
} as const satisfies Record<MigrationRefusal, string>;

// A rung named on the wire; anything off the ladder is the caller's mistake, never a 500.
const requireLadderTier = (id: string): HostedTier => {
    if (!isHostedTierId(id)) {
        throw new ORPCError(`BAD_REQUEST`, { message: `there is no machine called ${id}` });
    }
    return hostedTier(id);
};

// A rung that can be BOUGHT; the free one is the lane, and no amount of money adds a slot at it.
const requirePaidTier = (config: Config, id: string): HostedTier => {
    const tier = requireLadderTier(id);
    if (tier.priceUsd === 0 || !hostedPrices(config).has(tier.id)) {
        throw new ORPCError(`BAD_REQUEST`, { message: `${tier.name} is not something this platform sells slots at` });
    }
    return tier;
};

/** One migration as the wire carries it; the page watches `state` and reads `error` when it stops. */
const migrationStateOf = (row: {
    id: string;
    sandboxId: string;
    kind: string;
    state: string;
    fromTier: string;
    toTier: string;
    startedAt: Date;
    finishedAt: Date | null;
    error: string | null;
}): HostedMigrationState => ({
    id: row.id,
    sandboxId: row.sandboxId,
    kind: row.kind === `move` ? `move` : `resize`,
    state: row.state as HostedMigrationState[`state`],
    fromTier: row.fromTier,
    toTier: row.toTier,
    startedAt: row.startedAt.toISOString(),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() }),
    ...(row.error === null ? {} : { error: row.error }),
});

// The browser half of the plan: Billing page state, Stripe-hosted doors, and the one write the platform makes itself
// (slots). Checkout carries the user id as client_reference_id; the webhook turns a completed payment into a plan row.
export const hostedPlanRoutes = (gateway?: StripeGateway) => {
    const stripe = (context: OrpcContext): StripeGateway => gateway ?? stripeGateway(context.config.hostedPlan);
    // A refusal from Stripe is a bad gateway with Stripe's own words, never an unhandled 500: the words are what tells
    // the buyer it is not their card and the operator which knob is wrong.
    const throughStripe = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
            return await work();
        } catch (error) {
            if (error instanceof StripeError) {
                throw new ORPCError(`BAD_GATEWAY`, { message: error.message });
            }
            throw error;
        }
    };
    return {
        state: os.hostedPlan.state.handler(({ context }) => hostedPlanStateOf(context)),
        checkout: os.hostedPlan.checkout.handler(async ({ context, input }) => {
            const { config, prisma } = context;
            const user = requireUser(context);
            requirePlanEnabled(context);
            // Named rung, or the cheapest on sale. The `undefined` branch is guaranteed away by requirePlanEnabled,
            // which is the same question: a platform selling nothing has no checkout.
            const asked = input.tier === undefined ? entryTier(config) : { tier: requirePaidTier(config, input.tier), priceId: `` };
            if (asked === undefined) {
                throw new ORPCError(`NOT_FOUND`, { message: `the hosted plan is not enabled on this platform` });
            }
            const entry = { tier: asked.tier, priceId: asked.priceId === `` ? (hostedPrices(config).get(asked.tier.id) as string) : asked.priceId };
            const plan = await prisma.hostedPlan.findUnique({ where: { userId: user.id }, select: { status: true, stripeCustomerId: true } });
            // A second checkout on the plan would be a second subscription; upsert-by-user keeps one row instead.
            if (isOnPlan(plan)) {
                throw new ORPCError(`CONFLICT`, { message: `you are already on the hosted plan` });
            }
            return throughStripe(() =>
                stripe(context).checkoutSession({
                    priceId: entry.priceId,
                    clientReferenceId: user.id,
                    customerEmail: user.email,
                    // A resubscriber is the same Stripe customer they were: one invoice history, one portal.
                    ...(plan === null ? {} : { customer: plan.stripeCustomerId }),
                    successUrl: billingUrl(context, `?plan=welcome`),
                    cancelUrl: billingUrl(context),
                }),
            );
        }),
        portal: os.hostedPlan.portal.handler(async ({ context }) => {
            const { prisma } = context;
            const user = requireUser(context);
            requirePlanEnabled(context);
            const plan = await prisma.hostedPlan.findUnique({ where: { userId: user.id } });
            if (plan === null) {
                throw new ORPCError(`NOT_FOUND`, { message: `no plan to manage` });
            }
            return throughStripe(() => stripe(context).portalSession(plan.stripeCustomerId, billingUrl(context)));
        }),
        // How many slots this account holds at one rung; refused below the machines already standing on them, since
        // a slot with a machine on it cannot be sold back. Written on Stripe with proration, mirrored at once rather
        // than waiting on the webhook.
        setSlots: os.hostedPlan.setSlots.handler(async ({ context, input }) => {
            const { config, prisma } = context;
            const user = requireUser(context);
            requirePlanEnabled(context);
            const tier = requirePaidTier(config, input.tier);
            const plan = await prisma.hostedPlan.findUnique({ where: { userId: user.id }, include: { items: true } });
            if (!isOnPlan(plan) || plan === null) {
                throw new ORPCError(`PRECONDITION_FAILED`, { message: `subscribe to the hosted plan first` });
            }
            const standing = await prisma.hostedMachine.count({ where: { tier: tier.id, sandbox: { ownerId: user.id } } });
            if (input.quantity < standing) {
                throw new ORPCError(`BAD_REQUEST`, {
                    message: `${standing} of your sandboxes are on ${tier.name}; move one down a rung before giving up its slot`,
                });
            }
            const priceId = hostedPrices(config).get(tier.id);
            if (priceId === undefined) {
                throw new ORPCError(`NOT_FOUND`, { message: `${tier.name} is not on sale on this platform` });
            }
            // Every rung's item in one update: Stripe's own answer is then the whole picture the mirror writes.
            const existing = plan.items.find((item) => item.tier === tier.id);
            const updated = await throughStripe(() =>
                stripe(context).setItems(plan.stripeSubscriptionId, [
                    { ...(existing === undefined ? {} : { itemId: existing.stripeItemId }), priceId, quantity: input.quantity },
                ]),
            );
            await applySubscription(prisma, config, updated, { userId: user.id });
            return hostedPlanStateOf(context);
        }),
        /* MOVES ONE SANDBOX'S MACHINE ONTO A SLOT AT ANOTHER RUNG. The slot must already be bought (setSlots), which
         * is what keeps money and machines two separate, separately reversible acts: a migration that rolls back
         * leaves a paid-for empty slot, never a charge with nothing behind it. */
        changeTier: os.hostedPlan.changeTier.handler(async ({ context, input }) => {
            const { config, logger, prisma } = context;
            const user = requireUser(context);
            const tier = requireLadderTier(input.tier);
            const machine = await prisma.hostedMachine.findUnique({
                where: { sandboxId: input.sandboxId },
                include: { sandbox: { select: { ownerId: true, token: true, owner: { select: { email: true } } } } },
            });
            if (machine === null || machine.sandbox.ownerId !== user.id) {
                throw new ORPCError(`NOT_FOUND`, { message: `you have no hosted sandbox by that id` });
            }
            const slots = await hostedSlotsOf(prisma, config, user.id);
            const held = await prisma.hostedMachine.count({
                where: { tier: tier.id, sandbox: { ownerId: user.id }, NOT: { sandboxId: input.sandboxId } },
            });
            if (held >= slotsAtTier(slots, tier.id)) {
                throw new ORPCError(`PRECONDITION_FAILED`, {
                    message: tier.priceUsd === 0 ? `you have no free slot left` : `buy a ${tier.name} slot first`,
                });
            }
            try {
                const row = await migrateHosted(prisma, config, logger, machine, { tier: tier.id }, user.email.toLowerCase());
                return migrationStateOf(row);
            } catch (error) {
                if (error instanceof HostedMigrationRefused) {
                    throw new ORPCError(MIGRATION_REFUSALS[error.code], { message: error.message });
                }
                throw error;
            }
        }),
    };
};
