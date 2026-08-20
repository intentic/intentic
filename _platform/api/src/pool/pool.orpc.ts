import { apiContract, type MembershipState, type ServiceOfferCard, type ServiceOfferSettled } from "@intentic-app/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { readOffer, settleOffer } from "../mcp/mcp-offer.js";
import { creditStatus } from "./pool-credits.js";
import { isPremium, poolEnabled } from "./pool-membership.js";
import { type StripeGateway, stripeGateway } from "./pool-stripe.js";

const os = implement(apiContract).$context<OrpcContext>();

/* The browser half of the creator pool: the settings card's state and its two Stripe-hosted doors. Checkout
 * carries the user id as client_reference_id, the webhook (pool.routes.ts) is what turns the completed
 * payment into a membership row, so a checkout the user abandons leaves nothing behind. */
export const poolRoutes = (gateway?: StripeGateway) => ({
    membership: os.pool.membership.handler(async ({ context }): Promise<MembershipState> => {
        const { config, prisma } = context;
        // The published figures ride on every answer, including the disabled one: they describe the offer,
        // not the caller, and the card that renders the offer is talking to someone who has not bought it.
        const disabled: MembershipState = {
            enabled: false,
            member: false,
            priceUsd: config.pool.priceUsd,
            creatorShare: config.pool.creatorShare,
            dailyCredits: config.pool.dailyCredits,
            donationCredits: config.pool.donationCredits,
        };
        if (!poolEnabled(config)) {
            return disabled;
        }
        // Signed out: the card renders the offer; joining starts with the ordinary sign-in.
        if (context.user === null) {
            return { ...disabled, enabled: true };
        }
        const membership = await prisma.membership.findUnique({ where: { userId: context.user.id } });
        const member = isPremium(membership);
        return {
            enabled: true,
            member,
            ...(membership !== null ? { status: membership.status, renewsAt: membership.currentPeriodEnd.toISOString() } : {}),
            priceUsd: config.pool.priceUsd,
            creatorShare: config.pool.creatorShare,
            dailyCredits: config.pool.dailyCredits,
            donationCredits: config.pool.donationCredits,
            // Only a member has a meter, the card shows the allowance beside the membership it belongs to.
            ...(member ? { credits: await creditStatus(prisma, config, context.user.id, new Date()) } : {}),
        };
    }),
    checkout: os.pool.checkout.handler(async ({ context, input }) => {
        const { config } = context;
        const user = requireUser(context);
        if (!poolEnabled(config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `the creator pool is not enabled on this platform` });
        }
        const stripe = gateway ?? stripeGateway(config.pool.stripeSecretKey);
        /* Back where they started, which is now two different places. Somebody who opened the membership tab
         * gets the membership tab; somebody who arrived from a terminal with no sandbox gets /join, because
         * /settings sits inside the workspace shell and the shell would bounce them to setup, which is the
         * exact wrong thing to show a person thirty seconds after taking their money. */
        const lane = input.returnTo === `join` ? `/join` : `/settings/membership`;
        return stripe.checkoutSession({
            priceId: config.pool.stripePriceId,
            clientReferenceId: user.id,
            customerEmail: user.email,
            successUrl: `${config.webOrigin}${lane}?membership=welcome`,
            cancelUrl: `${config.webOrigin}${lane}`,
        });
    }),
    /* THE APPROVAL PAGE'S READ. Scoped to the caller's own account inside `readOffer`, which matters more here
     * than the usual amount: an offer id is a cuid that arrives in a URL somebody's terminal printed, and the
     * page it opens shows a request body an agent composed, which can carry anything the task was about.
     *
     * The meter rides along so the page can put the price against what is actually left today, from the same
     * read the platform charges from. A non-member gets no meter and the page turns that into a join prompt
     * rather than a button that cannot work. */
    offer: os.pool.offer.handler(async ({ context, input }): Promise<ServiceOfferCard> => {
        const { config, prisma } = context;
        const user = requireUser(context);
        if (!poolEnabled(config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `the creator pool is not enabled on this platform` });
        }
        const card = await readOffer(prisma, input.id, user.id, new Date());
        if (card === undefined) {
            throw new ORPCError(`NOT_FOUND`, { message: `no such approval` });
        }
        const meter = (await isPremium(await prisma.membership.findUnique({ where: { userId: user.id } })))
            ? await creditStatus(prisma, config, user.id, new Date())
            : undefined;
        return {
            ...card,
            ...(meter !== undefined ? { credits_remaining: meter.remaining, allowance: meter.allowance } : {}),
        };
    }),

    /* THE CLICK, the only thing on this platform that moves an offer to `approved`, and the only reason the
     * agent-facing half can be as open as it is. It is reachable exclusively from a browser session, which is
     * the one credential a calling agent cannot obtain, hold or forge; the agent's own report that its user
     * said yes is never read, here or anywhere.
     *
     * That is what makes the port honest rather than decorative. Claude Code can auto-answer the dialog that
     * sends somebody here (it ships a hook for exactly that); auto-answering it releases nothing, because the
     * run re-reads the row this handler writes. */
    settleOffer: os.pool.settleOffer.handler(async ({ context, input }): Promise<ServiceOfferSettled> => {
        const { config, prisma } = context;
        const user = requireUser(context);
        if (!poolEnabled(config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `the creator pool is not enabled on this platform` });
        }
        const outcome = await settleOffer(prisma, input.id, user.id, input.approve, new Date());
        if (outcome === `unknown`) {
            throw new ORPCError(`NOT_FOUND`, { message: `no such approval` });
        }
        return { outcome };
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
