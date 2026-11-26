import type { PrismaClient } from "@intentic/prisma";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../../../config.js";
import { applySubscription, hostedPlanEnabled } from "./hosted-plan.js";
import { kickPlanChange } from "./hosted-plan-changes.js";
import { type StripeGateway, stripeGateway, subscriptionIdOfEvent, verifyStripeSignature } from "./hosted-plan-stripe.js";
import { isPaidTier } from "./plan-change.js";

// The hosted plan's one non-browser route: Stripe's webhook, authenticated by its signature. The browser half (state,
// checkout, portal) rides the oRPC contract (hosted-plan.orpc.ts). 404s entirely while the plan is unconfigured.

export interface HostedPlanDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    // Injectable so tests drive the webhook without Stripe, like the trial pool's fetchFn.
    readonly gateway?: StripeGateway;
    readonly now?: () => Date;
}

export const hostedPlanHttpRoutes = ({ config, prisma, gateway, now = () => new Date() }: HostedPlanDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    // Lazy: built on the first webhook that needs it, so a plan-less platform constructs nothing Stripe-shaped.
    const stripe = (): StripeGateway => gateway ?? stripeGateway(config.hostedPlan, fetch, now);

    /* A FIRST PLAN BOUGHT FOR A NAMED SANDBOX lands on it: paid from now, and resized in the background when it is not
     * on that tier yet. Only the buyer's own sandbox; a redelivered event finds the change already made, or running. */
    const putFirstPlanOn = async (logger: Logger, userId: string, sandboxId: string, tier: string): Promise<void> => {
        const machine = await prisma.hostedMachine.findUnique({ where: { sandboxId }, select: { tier: true, sandbox: { select: { ownerId: true } } } });
        if (machine === null || machine.sandbox.ownerId !== userId || !isPaidTier(tier)) {
            return;
        }
        const resize = machine.tier !== tier;
        await prisma.hostedMachine.update({ where: { sandboxId }, data: { paid: true, planTo: resize ? tier : null, planAt: resize ? now() : null } });
        if (resize) {
            kickPlanChange(prisma, config, logger, sandboxId);
        }
    };

    // Names the buyer (client_reference_id) and the subscription; the subscription is read fresh from Stripe rather
    // than trusted off the event. Anything else shaped is not for us.
    const onCheckoutCompleted = async (logger: Logger, object: unknown): Promise<void> => {
        const session = z
            .object({
                mode: z.literal(`subscription`),
                client_reference_id: z.string(),
                subscription: z.string(),
                metadata: z.object({ sandboxId: z.string().optional(), tier: z.string().optional() }).nullish(),
            })
            .safeParse(object);
        if (session.success) {
            const at = now();
            const userId = session.data.client_reference_id;
            await applySubscription(prisma, config, await stripe().subscription(session.data.subscription), { userId, at });
            const { sandboxId, tier } = session.data.metadata ?? {};
            if (sandboxId !== undefined && tier !== undefined) {
                await putFirstPlanOn(logger, userId, sandboxId, tier);
            }
        }
    };

    // Stripe delivers events out of order, so the event's own copy is never mirrored directly: the subscription is
    // re-read fresh, and that read's own moment is what applySubscription's ordering guard compares.
    const onSubscriptionChanged = async (object: unknown): Promise<void> => {
        const id = subscriptionIdOfEvent(object);
        if (id !== undefined) {
            const at = now();
            await applySubscription(prisma, config, await stripe().subscription(id), { at });
        }
    };

    // Signature-authenticated against the raw body; a plan enabled with no webhook secret refuses everything with 400
    // rather than absorbing it. Unrecognized event types still ack 200 so Stripe stops retrying.
    app.post(`/webhook`, async (c) => {
        if (!hostedPlanEnabled(config)) {
            return c.json({ error: `the hosted plan is not enabled on this platform` }, 404);
        }
        const payload = await c.req.text();
        if (!verifyStripeSignature(payload, c.req.header(`stripe-signature`), config.hostedPlan.stripeWebhookSecret, now)) {
            return c.json({ error: `bad signature` }, 400);
        }
        const event = z.object({ type: z.string(), data: z.object({ object: z.unknown() }) }).safeParse(JSON.parse(payload));
        if (!event.success) {
            return c.json({ error: `malformed event` }, 400);
        }
        const { type, data } = event.data;
        if (type === `checkout.session.completed`) {
            await onCheckoutCompleted(c.get(`logger`), data.object);
        } else if (type === `customer.subscription.updated` || type === `customer.subscription.deleted`) {
            await onSubscriptionChanged(data.object);
        }
        return c.json({ received: true });
    });

    return app;
};
