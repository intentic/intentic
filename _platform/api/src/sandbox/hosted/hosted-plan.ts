import { FREE_TIER, type HostedTier, type HostedTierId, hostedTier, isHostedTierId, PAID_TIERS } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { type StripeGateway, stripeGateway, type StripePrice, type StripeSubscription } from "./hosted-plan-stripe.js";

// The one thing this platform sells: a Stripe subscription for a bigger machine than the free rung, never collected,
// one slot per sandbox. Nothing else in the product reads it: money changes which machine agents run on, never what
// they can do.

/**
 * The Stripe Price each paid rung is sold at, from `tier=price_id` pairs. A rung missing from the list is not on sale;
 * a name that is not a paid rung is dropped here and named by checkHostedPlanPrices at boot.
 */
export const hostedPrices = (config: Config): ReadonlyMap<HostedTierId, string> => {
    const prices = new Map<HostedTierId, string>();
    for (const pair of config.hostedPlan.stripePrices.split(`,`)) {
        const [name = ``, priceId = ``] = pair.split(`=`).map((part) => part.trim());
        if (isHostedTierId(name) && hostedTier(name).priceUsd > 0 && priceId !== ``) {
            prices.set(name, priceId);
        }
    }
    return prices;
};

// The plan exists when the platform can both sell (at least one rung priced) and charge (a key); anything less and
// every plan surface answers not here.
export const hostedPlanEnabled = (config: Config): boolean => config.hostedPlan.stripeSecretKey !== `` && hostedPrices(config).size > 0;

/**
 * The cheapest rung on sale and the Stripe Price it is sold at, which is what a checkout naming no rung buys.
 * Undefined where nothing is on sale, which is the same condition hostedPlanEnabled reports.
 */
export const entryTier = (config: Config): { tier: HostedTier; priceId: string } | undefined => {
    const prices = hostedPrices(config);
    for (const tier of PAID_TIERS) {
        const priceId = prices.get(tier.id);
        if (priceId !== undefined) {
            return { tier, priceId };
        }
    }
    return undefined;
};

// Active and trialing count; past_due doesn't, since a retrying charge should read as paused, not silent.
const PLAN_STATUSES = new Set([`active`, `trialing`]);

export const isOnPlan = (plan: { status: string } | null): boolean => plan !== null && PLAN_STATUSES.has(plan.status);

// Subscriptions Stripe won't let anybody cancel, because they're already over.
const OVER_STATUSES = new Set([`canceled`, `incomplete_expired`]);

// Comp list, parsed at ask time, case-folded since an email's case is presentation, not identity.
const compEmails = (config: Config): readonly string[] =>
    config.hostedPlan.compEmails
        .split(`,`)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email !== ``);

// Whether this account's email is on the operator's comp list; read only when no paid row answered, so the paying path
// never pays for a lookup.
export const isComped = async (prisma: PrismaClient, config: Config, userId: string): Promise<boolean> => {
    const comped = compEmails(config);
    if (comped.length === 0) {
        return false;
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return user !== null && comped.includes(user.email.toLowerCase());
};

// On the plan: a live subscription, or an email on the comp list. Comp check runs only when no row answered; a comped
// user's plan reverts the moment the email leaves the list, since nothing was ever written down.
export const onHostedPlan = async (prisma: PrismaClient, config: Config, userId: string): Promise<boolean> => {
    if (isOnPlan(await prisma.hostedPlan.findUnique({ where: { userId }, select: { status: true } }))) {
        return true;
    }
    return isComped(prisma, config, userId);
};

/** An owner's slots by rung, none where absent: free's is `hosted.perUser` and never bought, and a lapsed plan's paid ones count none. */
export const hostedSlotsOf = async (
    prisma: Pick<PrismaClient, "hostedPlan">,
    config: Config,
    userId: string,
): Promise<ReadonlyMap<HostedTierId, number>> => {
    const slots = new Map<HostedTierId, number>([[FREE_TIER.id, config.hosted.perUser]]);
    const plan = await prisma.hostedPlan.findUnique({ where: { userId }, select: { status: true, items: true } });
    if (plan === null || !isOnPlan(plan)) {
        return slots;
    }
    for (const item of plan.items) {
        if (item.tier !== FREE_TIER.id && item.quantity > 0) {
            slots.set(hostedTier(item.tier).id, item.quantity);
        }
    }
    return slots;
};

/** The owner's machines at one rung, `except` one sandbox's own, and the slots left there for another. */
export const hostedSlotUse = async (
    prisma: Pick<PrismaClient, "hostedPlan" | "hostedMachine">,
    config: Config,
    ownerId: string,
    tier: HostedTierId,
    except?: string,
): Promise<{ used: number; left: number }> => {
    const [used, slots] = await Promise.all([
        prisma.hostedMachine.count({ where: { tier, sandbox: { ownerId }, ...(except === undefined ? {} : { NOT: { sandboxId: except } }) } }),
        hostedSlotsOf(prisma, config, ownerId),
    ]);
    return { used, left: (slots.get(tier) ?? 0) - used };
};

const money = (cents: number, currency: string): string => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

/* WHAT STOPS A RUNG'S CONFIGURED PRICE FROM BEING SOLD, in the words an operator can act on; empty when checkout will take it. */
export const priceFaults = (price: StripePrice, tier: HostedTier): readonly string[] => {
    const faults: string[] = [];
    if (!price.active) {
        faults.push(`it is archived in Stripe, and checkout only accepts active prices`);
    }
    if (price.interval === ``) {
        faults.push(`it is a one-off price, and the plan is sold in subscription mode`);
    }
    const advertised = Math.round(tier.priceUsd * 100);
    if (price.unitAmount !== advertised) {
        faults.push(`it charges ${money(price.unitAmount, price.currency)}, while the ladder advertises ${money(advertised, `usd`)}`);
    }
    return faults;
};

// Asks Stripe about every rung's price once, at boot: an archived or missing one is otherwise found by the first buyer,
// as a 500 on checkout and no word anywhere else. Never throws and never blocks serving; a refusal is a log line, and
// one rung's bad price never stops the rungs beside it being sold.
export const checkHostedPlanPrices = async (config: Config, logger: Logger, gateway?: StripeGateway): Promise<void> => {
    if (!hostedPlanEnabled(config)) {
        return;
    }
    const prices = hostedPrices(config);
    const unsold = PAID_TIERS.filter((tier) => !prices.has(tier.id)).map((tier) => tier.id);
    if (unsold.length > 0) {
        logger.warn({ unsold }, `hosted plan: no Stripe price for ${unsold.join(`, `)}; those rungs cannot be bought (HOSTED_PLAN_STRIPE_PRICES)`);
    }
    const stripe = gateway ?? stripeGateway(config.hostedPlan);
    for (const tier of PAID_TIERS) {
        const priceId = prices.get(tier.id);
        if (priceId === undefined) {
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one small read per rung, once at boot
        const price = await stripe.price(priceId).catch((error: unknown) => {
            logger.error({ err: error, tier: tier.id, priceId }, `hosted plan: Stripe would not answer for ${tier.id}'s price, so nobody can buy it`);
            return undefined;
        });
        if (price === undefined) {
            continue;
        }
        const faults = priceFaults(price, tier);
        if (faults.length > 0) {
            logger.error(
                { tier: tier.id, priceId, livemode: price.livemode, faults },
                `hosted plan: ${tier.id} cannot be sold: ${faults.join(`; `)}`,
            );
            continue;
        }
        const selling = `hosted plan: selling ${tier.id} (${priceId}) at ${money(price.unitAmount, price.currency)} per ${price.interval}`;
        if (price.livemode) {
            logger.info({ tier: tier.id, priceId }, selling);
            continue;
        }
        logger.warn({ tier: tier.id, priceId }, `${selling}, on a Stripe TEST-mode key: buyers subscribe and no money ever moves`);
    }
};

// Mirrors one subscription into the plan table; userId is known on checkout/slot writes, otherwise the customer id is
// the join. `at` stamps the read's own moment, since a later write must never be rolled back by an older one.
export const applySubscription = async (
    prisma: PrismaClient,
    config: Config,
    subscription: StripeSubscription,
    by: { userId?: string; at?: Date } = {},
): Promise<void> => {
    const syncedAt = by.at ?? new Date();
    const state = {
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        syncedAt,
    };
    const planId =
        by.userId === undefined
            ? await mirrorByCustomer(prisma, subscription, state, syncedAt)
            : (
                  await prisma.hostedPlan.upsert({
                      // One row per user: a cancel-then-rebuy arrives with a new subscription id, and upsert-by-user
                      // overwrites the old.
                      where: { userId: by.userId },
                      create: { userId: by.userId, ...state },
                      update: state,
                      select: { id: true },
                  })
              ).id;
    if (planId !== undefined) {
        await mirrorItems(prisma, config, planId, subscription);
    }
};

// The older read wins nothing: `syncedAt` is the platform's own clock at the read, and a write it precedes is dropped.
const mirrorByCustomer = async (
    prisma: PrismaClient,
    subscription: StripeSubscription,
    state: Record<string, unknown>,
    syncedAt: Date,
): Promise<string | undefined> => {
    const { count } = await prisma.hostedPlan.updateMany({
        where: { stripeCustomerId: subscription.customer, stripeSubscriptionId: subscription.id, syncedAt: { lte: syncedAt } },
        data: state,
    });
    if (count === 0) {
        return undefined;
    }
    const row = await prisma.hostedPlan.findUnique({ where: { stripeSubscriptionId: subscription.id }, select: { id: true } });
    return row?.id;
};

/* THE SLOTS THIS SUBSCRIPTION NOW HOLDS, rung by rung. An item whose price belongs to no rung of this ladder is
 * left alone rather than guessed at; an empty item list is a trimmed webhook object and changes nothing. */
const mirrorItems = async (prisma: PrismaClient, config: Config, planId: string, subscription: StripeSubscription): Promise<void> => {
    if (subscription.items.length === 0) {
        return;
    }
    const byPrice = new Map([...hostedPrices(config)].map(([tier, priceId]) => [priceId, tier]));
    const seen: HostedTierId[] = [];
    for (const item of subscription.items) {
        const tier = byPrice.get(item.priceId);
        if (tier === undefined) {
            continue;
        }
        seen.push(tier);
        // oxlint-disable-next-line eslint/no-await-in-loop -- one small write per rung, and there are three
        await prisma.hostedPlanItem.upsert({
            where: { planId_tier: { planId, tier } },
            create: { planId, tier, stripeItemId: item.id, quantity: item.quantity },
            update: { stripeItemId: item.id, quantity: item.quantity },
        });
    }
    // A rung Stripe no longer carries is a rung this account no longer holds slots at.
    await prisma.hostedPlanItem.deleteMany({ where: { planId, tier: { notIn: seen } } });
};

// Ends the subscription of an account being deleted: both deletion paths cascade the plan row alone, which used to
// leave Stripe still charging a ghost account. Called before the cascade; a Stripe refusal is logged, not blocking.
export const cancelHostedPlan = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    userId: string,
    gateway?: StripeGateway,
): Promise<void> => {
    if (!hostedPlanEnabled(config)) {
        return;
    }
    const plan = await prisma.hostedPlan.findUnique({ where: { userId }, select: { stripeSubscriptionId: true, status: true } });
    if (plan === null || OVER_STATUSES.has(plan.status)) {
        return;
    }
    try {
        await (gateway ?? stripeGateway(config.hostedPlan)).cancelSubscription(plan.stripeSubscriptionId);
        logger.info({ userId, subscription: plan.stripeSubscriptionId }, `hosted plan: subscription cancelled with its account`);
    } catch (error) {
        logger.error(
            { err: error, userId, subscription: plan.stripeSubscriptionId },
            `hosted plan: cancelling a deleted account's subscription failed; cancel it in Stripe by hand`,
        );
    }
};
