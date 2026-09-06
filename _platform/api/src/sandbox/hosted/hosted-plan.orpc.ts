import { apiContract, type HostedPlanState } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../context.js";
import { requireUser } from "../../guards.js";
import { hostedPlanEnabled, isOnPlan } from "./hosted-plan.js";
import { type StripeGateway, stripeGateway } from "./hosted-plan-stripe.js";

const os = implement(apiContract).$context<OrpcContext>();

/* The browser half of the hosted plan: the settings card's state and its two Stripe-hosted doors. Checkout
 * carries the user id as client_reference_id; the webhook (hosted-plan.routes.ts) is what turns the completed
 * payment into a plan row, so a checkout the user abandons leaves nothing behind. */
export const hostedPlanRoutes = (gateway?: StripeGateway) => ({
    state: os.hostedPlan.state.handler(async ({ context }): Promise<HostedPlanState> => {
        const { config, prisma } = context;
        // The price rides on every answer, including the disabled one: it describes the offer, not the
        // caller, and the card that renders the offer is talking to someone who has not bought it.
        const disabled: HostedPlanState = { enabled: false, onPlan: false, priceUsd: config.hostedPlan.priceUsd };
        if (!hostedPlanEnabled(config)) {
            return disabled;
        }
        // Signed out: the card renders the offer; buying starts with the ordinary sign-in.
        if (context.user === null) {
            return { ...disabled, enabled: true };
        }
        const plan = await prisma.hostedPlan.findUnique({ where: { userId: context.user.id } });
        return {
            enabled: true,
            onPlan: isOnPlan(plan),
            ...(plan !== null ? { status: plan.status, renewsAt: plan.currentPeriodEnd.toISOString() } : {}),
            priceUsd: config.hostedPlan.priceUsd,
        };
    }),
    checkout: os.hostedPlan.checkout.handler(async ({ context }) => {
        const { config } = context;
        const user = requireUser(context);
        if (!hostedPlanEnabled(config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `the hosted plan is not enabled on this platform` });
        }
        const stripe = gateway ?? stripeGateway(config.hostedPlan.stripeSecretKey);
        return stripe.checkoutSession({
            priceId: config.hostedPlan.stripePriceId,
            clientReferenceId: user.id,
            customerEmail: user.email,
            successUrl: `${config.webOrigin}/settings/hosted?plan=welcome`,
            cancelUrl: `${config.webOrigin}/settings/hosted`,
        });
    }),
    portal: os.hostedPlan.portal.handler(async ({ context }) => {
        const { config, prisma } = context;
        const user = requireUser(context);
        if (!hostedPlanEnabled(config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `the hosted plan is not enabled on this platform` });
        }
        const plan = await prisma.hostedPlan.findUnique({ where: { userId: user.id } });
        if (plan === null) {
            throw new ORPCError(`NOT_FOUND`, { message: `no plan to manage` });
        }
        const stripe = gateway ?? stripeGateway(config.hostedPlan.stripeSecretKey);
        return stripe.portalSession(plan.stripeCustomerId, `${config.webOrigin}/settings/hosted`);
    }),
});
