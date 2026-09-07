import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { type StripeGateway, stripeGateway, type StripeSubscription } from "./hosted-plan-stripe.js";

/* THE HOSTED PLAN: the one thing this platform sells. A Stripe subscription that makes the owner's hosted
 * sandboxes always on (no awake-hour ceiling, hosted-usage.ts) and never collected (hosted-idle.ts), one slot
 * per hosted sandbox (the subscription item's quantity). Nothing else in the product reads it: every feature
 * is in the free product, and money changes whose machine the agents run on, never what they can do
 * (docs/design/pricing-model.md, docs/design/billing-view.md). */

// The plan exists when the platform can both sell (a price) and charge (a key). Anything less and every
// plan surface answers "not here", the trial.keys precedent.
export const hostedPlanEnabled = (config: Config): boolean =>
    config.hostedPlan.stripeSecretKey !== `` && config.hostedPlan.stripePriceId !== ``;

/* THE ENTITLEMENT RULE, in one place. Active and trialing count; past_due does not. Stripe retries a failed
 * charge for days while reporting past_due, and the honest reading of "the charge failed" is that the plan
 * paused, not that it silently continues on money that never arrived. The webhook keeps `status` current, so
 * this needs no date arithmetic. */
const PLAN_STATUSES = new Set([`active`, `trialing`]);

export const isOnPlan = (plan: { status: string } | null): boolean => plan !== null && PLAN_STATUSES.has(plan.status);

// Subscriptions Stripe will not let anybody cancel, because they are already over.
const OVER_STATUSES = new Set([`canceled`, `incomplete_expired`]);

// The comp list, parsed at ask time, case-folded because an email's case is presentation, not identity.
const compEmails = (config: Config): readonly string[] =>
    config.hostedPlan.compEmails
        .split(`,`)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email !== ``);

// Whether this account's email is on the operator's comp list. Read only when no paid row answered, so the
// paying path never pays for a user lookup.
export const isComped = async (prisma: PrismaClient, config: Config, userId: string): Promise<boolean> => {
    const comped = compEmails(config);
    if (comped.length === 0) {
        return false;
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return user !== null && comped.includes(user.email.toLowerCase());
};

/* On the plan = a live subscription, or an email on the operator's comp list (config.hostedPlan.compEmails).
 * The comp check runs only when no plan row answered and the list is non-empty, so the paying path costs what
 * it always did; a comped user's plan reverts the moment the email leaves the list, because nothing was ever
 * written down. */
export const onHostedPlan = async (prisma: PrismaClient, config: Config, userId: string): Promise<boolean> => {
    if (isOnPlan(await prisma.hostedPlan.findUnique({ where: { userId }, select: { status: true } }))) {
        return true;
    }
    return isComped(prisma, config, userId);
};

/* HOW MANY HOSTED SANDBOXES THIS OWNER MAY HAVE: the plan's slot count while it is live, the free lane's
 * allowance (config.hosted.perUser) otherwise. A plan with fewer slots than the free lane gives would be a
 * plan that takes something away, so the free number is the floor. The comp list grants the free number:
 * comping is "always on", not "any number of machines". */
export const hostedSlotsOf = async (prisma: Pick<PrismaClient, "hostedPlan">, config: Config, userId: string): Promise<number> => {
    const plan = await prisma.hostedPlan.findUnique({ where: { userId }, select: { status: true, quantity: true } });
    return plan !== null && isOnPlan(plan) ? Math.max(plan.quantity, config.hosted.perUser) : config.hosted.perUser;
};

/* Mirror one subscription state into the plan table. `userId` is known on the checkout-completed path (the
 * session's client_reference_id) and on the platform's own writes (a slot change), and absent on webhook
 * lifecycle events, where the customer id is the only join, an event for a customer the table has never seen
 * is dropped, which is exactly right for events belonging to some other product on the same Stripe account.
 *
 * `at` is the platform's own clock at the moment the subscription was READ from Stripe. Stripe delivers
 * webhooks in no particular order and says so, and a row that takes whatever lands last can be rolled back to
 * a state Stripe has already left; so no write here trusts an event's copy of the subscription: the webhook,
 * the checkout and a slot change all read it fresh and stamp the read, and the customer-join write refuses a
 * read older than the one it last applied. ONE CLOCK, OURS, ON EVERY STAMP. The guard used to compare our
 * millisecond stamps against Stripe's whole-second `created`, which dropped for good every event Stripe
 * emitted in the same second as a write of ours, a cancel made right after a slot change among them; the
 * hermetic tier (hosted-plan.e2e.test.ts) is where that showed. */
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
        // A subscription answered with no item (none should be) keeps the id the row already has rather than blanking it.
        ...(subscription.itemId === `` ? {} : { stripeItemId: subscription.itemId }),
    };
    if (by.userId !== undefined) {
        // One plan row per user, whatever Stripe-side churn produced it: a user who cancelled and bought
        // again arrives here with a NEW subscription id, and the upsert-by-user overwrites the old.
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

/* END THE SUBSCRIPTION OF AN ACCOUNT THAT IS GOING AWAY. Both deletions (the owner's own, Better Auth's
 * deleteUser; the operator's GDPR erasure) cascade the plan row, and before this that was ALL they did: the
 * Stripe subscription kept charging a customer with no account left to open the portal from, and every later
 * webhook for it matched no row and was dropped. Called before the cascade, while the row still names the
 * subscription.
 *
 * A Stripe refusal is logged at error level and the deletion proceeds: an account erasure must not be held
 * hostage by a payment API, and the log line names the subscription for the manual cancel. */
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
