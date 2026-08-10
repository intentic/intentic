import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import type { StripeSubscription } from "./pool-stripe.js";

// The pool exists when the platform can both sell (a price) and charge (a key). Anything less and every
// pool surface answers "not here" — the trial.keys precedent.
export const poolEnabled = (config: Config): boolean => config.pool.stripeSecretKey !== `` && config.pool.stripePriceId !== ``;

/* THE PREMIUM RULE, in one place. Active and trialing count; past_due does not — Stripe retries a failed
 * charge for days while reporting past_due, and the honest reading of "the charge failed" is that premium
 * paused, not that it silently continues on money that never arrived. The webhook keeps `status` current, so
 * this needs no date arithmetic. */
const PREMIUM_STATUSES = new Set([`active`, `trialing`]);

export const isPremium = (membership: { status: string } | null): boolean => membership !== null && PREMIUM_STATUSES.has(membership.status);

export const premiumOf = async (prisma: PrismaClient, userId: string): Promise<boolean> =>
    isPremium(await prisma.membership.findUnique({ where: { userId }, select: { status: true } }));

/* Mirror one subscription state into the membership table. `userId` is known on the checkout-completed path
 * (the session's client_reference_id) and absent on later lifecycle events, where the customer id is the only
 * join — an event for a customer the table has never seen is dropped, which is exactly right for events
 * belonging to some other product on the same Stripe account. */
export const applySubscription = async (prisma: PrismaClient, subscription: StripeSubscription, userId?: string): Promise<void> => {
    const state = {
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
    };
    if (userId !== undefined) {
        // One membership row per user, whatever Stripe-side churn produced it: a user who cancelled and
        // bought again arrives here with a NEW subscription id, and the upsert-by-user overwrites the old.
        await prisma.membership.upsert({ where: { userId }, create: { userId, ...state }, update: state });
        return;
    }
    await prisma.membership.updateMany({
        where: { stripeCustomerId: subscription.customer, stripeSubscriptionId: subscription.id },
        data: { status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd },
    });
};
