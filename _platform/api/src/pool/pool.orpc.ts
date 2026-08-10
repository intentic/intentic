import { apiContract, type MembershipState } from "@intentic-app/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { isPremium, poolEnabled } from "./pool-membership.js";
import { type StripeGateway, stripeGateway } from "./pool-stripe.js";

const os = implement(apiContract).$context<OrpcContext>();

/* The browser half of the creator pool: the settings card's state and its two Stripe-hosted doors. Checkout
 * carries the user id as client_reference_id — the webhook (pool.routes.ts) is what turns the completed
 * payment into a membership row, so a checkout the user abandons leaves nothing behind. */
export const poolRoutes = (gateway?: StripeGateway) => ({
    membership: os.pool.membership.handler(async ({ context }): Promise<MembershipState> => {
        const { config, prisma } = context;
        const disabled: MembershipState = { enabled: false, member: false, priceUsd: config.pool.priceUsd, creatorShare: config.pool.creatorShare };
        if (!poolEnabled(config)) {
            return disabled;
        }
        // Signed out: the card renders the offer; joining starts with the ordinary sign-in.
        if (context.user === null) {
            return { ...disabled, enabled: true };
        }
        const membership = await prisma.membership.findUnique({ where: { userId: context.user.id } });
        return {
            enabled: true,
            member: isPremium(membership),
            ...(membership !== null ? { status: membership.status, renewsAt: membership.currentPeriodEnd.toISOString() } : {}),
            priceUsd: config.pool.priceUsd,
            creatorShare: config.pool.creatorShare,
        };
    }),
    checkout: os.pool.checkout.handler(async ({ context }) => {
        const { config } = context;
        const user = requireUser(context);
        if (!poolEnabled(config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `the creator pool is not enabled on this platform` });
        }
        const stripe = gateway ?? stripeGateway(config.pool.stripeSecretKey);
        // Back to settings either way — the membership card reads its state fresh and says what happened.
        return stripe.checkoutSession({
            priceId: config.pool.stripePriceId,
            clientReferenceId: user.id,
            customerEmail: user.email,
            successUrl: `${config.webOrigin}/settings/membership?membership=welcome`,
            cancelUrl: `${config.webOrigin}/settings/membership`,
        });
    }),
    portal: os.pool.portal.handler(async ({ context }) => {
        const { config, prisma } = context;
        const user = requireUser(context);
        if (!poolEnabled(config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `the creator pool is not enabled on this platform` });
        }
        const membership = await prisma.membership.findUnique({ where: { userId: user.id } });
        if (membership === null) {
            throw new ORPCError(`NOT_FOUND`, { message: `no membership to manage` });
        }
        const stripe = gateway ?? stripeGateway(config.pool.stripeSecretKey);
        return stripe.portalSession(membership.stripeCustomerId, `${config.webOrigin}/settings/membership`);
    }),
});
