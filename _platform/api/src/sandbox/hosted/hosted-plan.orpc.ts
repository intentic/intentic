import { apiContract, type HostedPlanHosted, type HostedPlanState } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../context.js";
import { requireUser } from "../../guards.js";
import { hostedEnabled } from "./hosted.js";
import { applySubscription, hostedPlanEnabled, hostedSlotsOf, isComped, isOnPlan } from "./hosted-plan.js";
import { type StripeGateway, stripeGateway } from "./hosted-plan-stripe.js";
import { hostedUsedMinutes, usageMonth, usageResetsAt } from "./hosted-usage.js";

const os = implement(apiContract).$context<OrpcContext>();

// Where Stripe sends the browser back: the Billing page, which owns the post-checkout wait and every state's words.
const billingUrl = (context: OrpcContext, query = ``): string => `${context.config.webOrigin}/settings/billing${query}`;

// The lane as it applies to one account: slots, machines, this month's meter, shared by the Billing page, avatar row
// and Overview card so they can't disagree. usedMinutes is live, shown to subscribers too.
const hostedFor = async (context: OrpcContext, userId: string, onPlan: boolean): Promise<HostedPlanHosted> => {
    const { prisma, config } = context;
    const now = new Date();
    const [slots, machines, usedMinutes] = await Promise.all([
        hostedSlotsOf(prisma, config, userId),
        prisma.hostedMachine.findMany({
            where: { sandbox: { ownerId: userId } },
            select: { region: true, wokeAt: true, sandbox: { select: { id: true, name: true } } },
            orderBy: { createdAt: `asc` },
        }),
        hostedUsedMinutes(prisma, userId, now),
    ]);
    const metered = config.hosted.monthlyHours > 0 && !onPlan;
    return {
        slots,
        machines: machines.map((machine) => ({
            sandboxId: machine.sandbox.id,
            name: machine.sandbox.name,
            region: machine.region,
            wokeAt: machine.wokeAt?.toISOString() ?? null,
        })),
        usage: {
            month: usageMonth(now),
            usedMinutes,
            allowanceMinutes: metered ? config.hosted.monthlyHours * 60 : null,
            resetsAt: usageResetsAt(now).toISOString(),
        },
        shape: { cpus: config.hosted.cpus, memoryMb: config.hosted.memoryMb, volumeGb: config.hosted.volumeGb },
    };
};

// The whole answer, for `state` and every write that ends by re-reading it. Plan half from the mirror row and comp list
// (hosted-plan.ts owns the rule); hosted half from hostedFor above.
const hostedPlanStateOf = async (context: OrpcContext): Promise<HostedPlanState> => {
    const { config, prisma } = context;
    // The price rides on every answer, even disabled: it describes the offer to someone who hasn't bought it.
    const base: HostedPlanState = { enabled: hostedPlanEnabled(config), onPlan: false, priceUsd: config.hostedPlan.priceUsd };
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
        ...(hostedEnabled(config) ? { hosted: await hostedFor(context, context.user.id, onPlan) } : {}),
    };
};

const requirePlanEnabled = (context: OrpcContext): void => {
    if (!hostedPlanEnabled(context.config)) {
        throw new ORPCError(`NOT_FOUND`, { message: `the hosted plan is not enabled on this platform` });
    }
};

// The browser half of the plan: Billing page state, Stripe-hosted doors, and the one write the platform makes itself
// (slots). Checkout carries the user id as client_reference_id; the webhook turns a completed payment into a plan row.
export const hostedPlanRoutes = (gateway?: StripeGateway) => {
    const stripe = (context: OrpcContext): StripeGateway => gateway ?? stripeGateway(context.config.hostedPlan);
    return {
        state: os.hostedPlan.state.handler(({ context }) => hostedPlanStateOf(context)),
        checkout: os.hostedPlan.checkout.handler(async ({ context }) => {
            const { config, prisma } = context;
            const user = requireUser(context);
            requirePlanEnabled(context);
            const plan = await prisma.hostedPlan.findUnique({ where: { userId: user.id }, select: { status: true, stripeCustomerId: true } });
            // A second checkout on the plan would be a second subscription; upsert-by-user keeps one row instead.
            if (isOnPlan(plan)) {
                throw new ORPCError(`CONFLICT`, { message: `you are already on the hosted plan` });
            }
            return stripe(context).checkoutSession({
                priceId: config.hostedPlan.stripePriceId,
                clientReferenceId: user.id,
                customerEmail: user.email,
                // A resubscriber is the same Stripe customer they were: one invoice history, one portal.
                ...(plan === null ? {} : { customer: plan.stripeCustomerId }),
                successUrl: billingUrl(context, `?plan=welcome`),
                cancelUrl: billingUrl(context),
            });
        }),
        portal: os.hostedPlan.portal.handler(async ({ context }) => {
            const { prisma } = context;
            const user = requireUser(context);
            requirePlanEnabled(context);
            const plan = await prisma.hostedPlan.findUnique({ where: { userId: user.id } });
            if (plan === null) {
                throw new ORPCError(`NOT_FOUND`, { message: `no plan to manage` });
            }
            return stripe(context).portalSession(plan.stripeCustomerId, billingUrl(context));
        }),
        // How many hosted sandboxes the plan covers; refused below the count already in use, since a slot with a
        // machine on it can't be sold back. Written on Stripe with proration, mirrored at once rather than waiting on
        // the webhook.
        setSlots: os.hostedPlan.setSlots.handler(async ({ context, input }) => {
            const { prisma } = context;
            const user = requireUser(context);
            requirePlanEnabled(context);
            const plan = await prisma.hostedPlan.findUnique({ where: { userId: user.id } });
            if (!isOnPlan(plan) || plan === null) {
                throw new ORPCError(`PRECONDITION_FAILED`, { message: `subscribe to the hosted plan first` });
            }
            const machines = await prisma.hostedMachine.count({ where: { sandbox: { ownerId: user.id } } });
            if (input.quantity < machines) {
                throw new ORPCError(`BAD_REQUEST`, {
                    message: `you have ${machines} hosted sandboxes; remove one before giving up its slot`,
                });
            }
            const gatewayNow = stripe(context);
            // A row mirrored before the item id was read has none; the subscription itself always does.
            const itemId = plan.stripeItemId === `` ? (await gatewayNow.subscription(plan.stripeSubscriptionId)).itemId : plan.stripeItemId;
            if (itemId === ``) {
                throw new ORPCError(`BAD_GATEWAY`, { message: `Stripe returned a subscription with no item to change` });
            }
            const updated = await gatewayNow.setQuantity(plan.stripeSubscriptionId, itemId, input.quantity);
            await applySubscription(prisma, updated, { userId: user.id });
            return hostedPlanStateOf(context);
        }),
    };
};
