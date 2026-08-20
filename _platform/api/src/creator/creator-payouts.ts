import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import type { ConnectAccount, StripeGateway } from "../pool/pool-stripe.js";

/* WHERE A CREATOR'S MONEY GOES, the second half of phase one, and the half the platform deliberately does the
 * least of. Bank details, identity documents and tax forms are collected by Stripe's own hosted onboarding
 * against a connected account; what lands here is an account id and the three answers a payout decision is
 * made of. That is not laziness about compliance, it is the point: money out is the part of this system where
 * holding less is strictly safer, and an Express account means the platform never has a field to leak.
 *
 * Readiness is mirrored from TWO directions on purpose. Stripe's `account.updated` webhook is the fast path and
 * arrives whether or not anyone is looking; the read-through refresh below is what makes the screen right the
 * instant a creator lands back from onboarding, when the webhook may be seconds behind. Neither is trusted to
 * be the only one, because a creator staring at "not ready" while Stripe says otherwise is exactly the kind of
 * silence this phase exists to remove. */

// Where Stripe returns the creator once the hosted flow is finished, and where it sends them when a link has
// gone stale (straight back to minting a fresh one, the whole reason the link is never stored).
const returnPath = (config: Config): string => `${config.webOrigin}/settings/payouts?payouts=done`;
const refreshPath = (config: Config): string => `${config.webOrigin}/settings/payouts?payouts=refresh`;

export interface PayoutState {
    // Whether the creator has begun at all, an account exists on Stripe's side.
    readonly connected: boolean;
    // The only field the settlement job may read as permission to send money.
    readonly payoutsEnabled: boolean;
    // Finished the questions, which is not the same as cleared to be paid.
    readonly detailsSubmitted: boolean;
    // Why a finished account still cannot be paid, when Stripe names a cause.
    readonly disabledReason?: string;
}

// The stored row, structurally, the pool-membership.ts precedent: these modules read a handful of columns and
// naming them here keeps the logic testable without the generated client.
interface StoredAccount {
    readonly stripeAccountId: string;
    readonly payoutsEnabled: boolean;
    readonly detailsSubmitted: boolean;
    readonly disabledReason: string | null;
}

const stateOf = (account: StoredAccount | null): PayoutState =>
    account === null
        ? { connected: false, payoutsEnabled: false, detailsSubmitted: false }
        : {
              connected: true,
              payoutsEnabled: account.payoutsEnabled,
              detailsSubmitted: account.detailsSubmitted,
              ...(account.disabledReason !== null ? { disabledReason: account.disabledReason } : {}),
          };

// Write one freshly-read account onto the row it belongs to. `disabledReason` is explicitly nulled when Stripe
// stops naming one, so a cause that has been resolved disappears from the screen instead of haunting it.
const applyAccountTo = async (prisma: PrismaClient, userId: string, account: ConnectAccount): Promise<PayoutState> => {
    const data = {
        payoutsEnabled: account.payoutsEnabled,
        detailsSubmitted: account.detailsSubmitted,
        disabledReason: account.disabledReason ?? null,
    };
    await prisma.payoutAccount.update({ where: { userId }, data });
    return stateOf({ stripeAccountId: account.id, ...data });
};

/* The creator's payout state, refreshed through to Stripe while it is still unfinished. A ready account is
 * answered from the row alone, it is the steady state, the webhook keeps it current, and a Stripe round-trip
 * on every settings render would buy nothing. An unfinished one is re-read, because that is precisely the
 * window where the row is most likely to be a few seconds stale and the creator is most likely to be watching.
 * A Stripe failure degrades to the stored answer rather than failing the screen. */
export const payoutState = async (prisma: PrismaClient, gateway: StripeGateway, userId: string): Promise<PayoutState> => {
    const account = await prisma.payoutAccount.findUnique({ where: { userId } });
    if (account === null || account.payoutsEnabled) {
        return stateOf(account);
    }
    try {
        return await applyAccountTo(prisma, userId, await gateway.account(account.stripeAccountId));
    } catch {
        return stateOf(account);
    }
};

/* Start (or resume) payout setup: the URL the browser is sent to. The connected account is created once and
 * remembered; every visit after that mints a fresh link against the same account, so a creator who abandons
 * the flow and comes back a week later continues where they stopped instead of starting a second account they
 * would then have to be paid across. */
export const startPayoutSetup = async (
    prisma: PrismaClient,
    gateway: StripeGateway,
    config: Config,
    user: { readonly id: string; readonly email: string },
): Promise<{ url: string }> => {
    const existing = await prisma.payoutAccount.findUnique({ where: { userId: user.id }, select: { stripeAccountId: true } });
    let accountId = existing?.stripeAccountId;
    if (accountId === undefined) {
        const created = await gateway.createAccount({ email: user.email });
        await prisma.payoutAccount.create({
            data: {
                userId: user.id,
                stripeAccountId: created.id,
                payoutsEnabled: created.payoutsEnabled,
                detailsSubmitted: created.detailsSubmitted,
                disabledReason: created.disabledReason ?? null,
            },
        });
        accountId = created.id;
    }
    return gateway.accountLink({ accountId, refreshUrl: refreshPath(config), returnUrl: returnPath(config) });
};

/* The webhook's mirror. Keyed by the connected-account id rather than a user, because that is all the event
 * carries, and an event for an account this platform has never seen is dropped, exactly as a subscription
 * event for an unknown customer is: it belongs to some other product on the same Stripe account. */
export const applyAccountEvent = async (prisma: PrismaClient, account: ConnectAccount): Promise<void> => {
    await prisma.payoutAccount.updateMany({
        where: { stripeAccountId: account.id },
        data: {
            payoutsEnabled: account.payoutsEnabled,
            detailsSubmitted: account.detailsSubmitted,
            disabledReason: account.disabledReason ?? null,
        },
    });
};
