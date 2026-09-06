import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import type { StripeSubscription } from "./hosted-plan-stripe.js";

/* THE HOSTED PLAN: the one thing this platform sells. A Stripe subscription that makes the owner's hosted
 * sandbox always on (no awake-hour ceiling, hosted-usage.ts) and never collected (hosted-idle.ts). Nothing
 * else in the product reads it: every feature is in the free product, and money changes whose machine the
 * agents run on, never what they can do (docs/design/pricing-model.md). */

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

// The comp list, parsed at ask time, case-folded because an email's case is presentation, not identity.
const compEmails = (config: Config): readonly string[] =>
    config.hostedPlan.compEmails
        .split(`,`)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email !== ``);

/* On the plan = a live subscription, or an email on the operator's comp list (config.hostedPlan.compEmails).
 * The comp check runs only when no plan row answered and the list is non-empty, so the paying path costs what
 * it always did; a comped user's plan reverts the moment the email leaves the list, because nothing was ever
 * written down. */
export const onHostedPlan = async (prisma: PrismaClient, config: Config, userId: string): Promise<boolean> => {
    if (isOnPlan(await prisma.hostedPlan.findUnique({ where: { userId }, select: { status: true } }))) {
        return true;
    }
    const comped = compEmails(config);
    if (comped.length === 0) {
        return false;
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return user !== null && comped.includes(user.email.toLowerCase());
};

/* Mirror one subscription state into the plan table. `userId` is known on the checkout-completed path (the
 * session's client_reference_id) and absent on later lifecycle events, where the customer id is the only
 * join, an event for a customer the table has never seen is dropped, which is exactly right for events
 * belonging to some other product on the same Stripe account. */
export const applySubscription = async (prisma: PrismaClient, subscription: StripeSubscription, userId?: string): Promise<void> => {
    const state = {
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
    };
    if (userId !== undefined) {
        // One plan row per user, whatever Stripe-side churn produced it: a user who cancelled and bought
        // again arrives here with a NEW subscription id, and the upsert-by-user overwrites the old.
        await prisma.hostedPlan.upsert({ where: { userId }, create: { userId, ...state }, update: state });
        return;
    }
    await prisma.hostedPlan.updateMany({
        where: { stripeCustomerId: subscription.customer, stripeSubscriptionId: subscription.id },
        data: { status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd },
    });
};
