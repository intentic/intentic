import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { type StripeGateway, stripeGateway, type StripePrice, type StripeSubscription } from "./hosted-plan-stripe.js";

// The one thing this platform sells: a Stripe subscription that makes the owner's hosted sandboxes always on (no
// awake-hour ceiling) and never collected, one slot per sandbox (the subscription item's quantity). Nothing else in the
// product reads it: money changes whose machine agents run on, never what they can do.

// The plan exists when the platform can both sell (a price) and charge (a key); anything less and every plan surface
// answers not here.
export const hostedPlanEnabled = (config: Config): boolean =>
    config.hostedPlan.stripeSecretKey !== `` && config.hostedPlan.stripePriceId !== ``;

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

/* HOW MANY HOSTED SANDBOXES THIS OWNER MAY HAVE: the plan's slot count while it is live, the free lane's allowance (config.hosted.perUser) otherwise. */
export const hostedSlotsOf = async (prisma: Pick<PrismaClient, "hostedPlan">, config: Config, userId: string): Promise<number> => {
    const plan = await prisma.hostedPlan.findUnique({ where: { userId }, select: { status: true, quantity: true } });
    return plan !== null && isOnPlan(plan) ? Math.max(plan.quantity, config.hosted.perUser) : config.hosted.perUser;
};

const money = (cents: number, currency: string): string => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

/* WHAT STOPS THE CONFIGURED PRICE FROM BEING SOLD, in the words an operator can act on; empty when checkout will take it. */
export const priceFaults = (price: StripePrice, config: Config): readonly string[] => {
    const faults: string[] = [];
    if (!price.active) {
        faults.push(`it is archived in Stripe, and checkout only accepts active prices`);
    }
    if (price.interval === ``) {
        faults.push(`it is a one-off price, and the plan is sold in subscription mode`);
    }
    const advertised = Math.round(config.hostedPlan.priceUsd * 100);
    if (price.unitAmount !== advertised) {
        faults.push(`it charges ${money(price.unitAmount, price.currency)}, while the Billing page advertises ${money(advertised, `usd`)}`);
    }
    return faults;
};

// Asks Stripe about the price once, at boot: an archived or missing one is otherwise found by the first buyer, as a 500
// on checkout and no word anywhere else. Never throws and never blocks serving; a refusal is a log line.
export const checkHostedPlanPrice = async (config: Config, logger: Logger, gateway?: StripeGateway): Promise<void> => {
    if (!hostedPlanEnabled(config)) {
        return;
    }
    const priceId = config.hostedPlan.stripePriceId;
    let price: StripePrice;
    try {
        price = await (gateway ?? stripeGateway(config.hostedPlan)).price(priceId);
    } catch (error) {
        logger.error({ err: error, priceId }, `hosted plan: Stripe would not answer for the configured price, so nobody can subscribe`);
        return;
    }
    const faults = priceFaults(price, config);
    if (faults.length > 0) {
        logger.error({ priceId, livemode: price.livemode, faults }, `hosted plan: the configured price cannot be sold: ${faults.join(`; `)}`);
        return;
    }
    const selling = `hosted plan: selling ${priceId} at ${money(price.unitAmount, price.currency)} per ${price.interval}`;
    if (price.livemode) {
        logger.info({ priceId }, selling);
        return;
    }
    logger.warn({ priceId }, `${selling}, on a Stripe TEST-mode key: buyers subscribe and no money ever moves`);
};

// Mirrors one subscription into the plan table; userId is known on checkout/slot writes, otherwise the customer id is
// the join. `at` stamps the read's own moment, since a later write must never be rolled back by an older one.
export const applySubscription = async (
    prisma: PrismaClient,
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
        quantity: subscription.quantity,
        syncedAt,
        // A subscription with no item keeps the row's existing id rather than blanking it.
        ...(subscription.itemId === `` ? {} : { stripeItemId: subscription.itemId }),
    };
    if (by.userId !== undefined) {
        // One row per user: a cancel-then-rebuy arrives with a new subscription id, and upsert-by-user overwrites the
        // old.
        await prisma.hostedPlan.upsert({ where: { userId: by.userId }, create: { userId: by.userId, ...state }, update: state });
        return;
    }
    await prisma.hostedPlan.updateMany({
        where: { stripeCustomerId: subscription.customer, stripeSubscriptionId: subscription.id, syncedAt: { lte: syncedAt } },
        data: {
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            quantity: subscription.quantity,
            syncedAt,
            ...(subscription.itemId === `` ? {} : { stripeItemId: subscription.itemId }),
        },
    });
};

// Ends the subscription of an account being deleted: both deletion paths cascade the plan row alone, which used to
// leave Stripe still charging a ghost account. Called before the cascade; a Stripe refusal is logged, not blocking.
export const cancelHostedPlan = async (prisma: PrismaClient, config: Config, logger: Logger, userId: string, gateway?: StripeGateway): Promise<void> => {
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
