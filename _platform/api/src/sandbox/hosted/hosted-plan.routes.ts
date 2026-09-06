import type { PrismaClient } from "@intentic/prisma";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../../config.js";
import { applySubscription, hostedPlanEnabled } from "./hosted-plan.js";
import { type StripeGateway, stripeGateway, subscriptionFromEvent, verifyStripeSignature } from "./hosted-plan-stripe.js";

/* The hosted plan's one non-browser route: Stripe's webhook, authenticated by its signature. The browser
 * half (state, checkout, portal) rides the oRPC contract (hosted-plan.orpc.ts). 404s entirely while the plan
 * is unconfigured, trial-style: a self-hosted platform that sells nothing has nothing here. */

export interface HostedPlanDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    // Injectable so tests drive the webhook without Stripe, like the trial pool's fetchFn.
    readonly gateway?: StripeGateway;
    readonly now?: () => Date;
}

export const hostedPlanHttpRoutes = ({ config, prisma, gateway, now = () => new Date() }: HostedPlanDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    // Lazy: built on the first webhook that needs it, so mounting the sub-app on a platform without a plan
    // (every test config, most self-hosted ones) constructs nothing Stripe-shaped.
    const stripe = (): StripeGateway => gateway ?? stripeGateway(config.hostedPlan.stripeSecretKey, fetch, now);

    /* A completed subscription checkout names the buyer (client_reference_id) and the subscription, which is
     * read fresh from Stripe rather than trusted off the event. Anything else shaped is not for us. */
    const onCheckoutCompleted = async (object: unknown): Promise<void> => {
        const session = z
            .object({ mode: z.literal(`subscription`), client_reference_id: z.string(), subscription: z.string() })
            .safeParse(object);
        if (session.success) {
            await applySubscription(prisma, await stripe().subscription(session.data.subscription), session.data.client_reference_id);
        }
    };

    const onSubscriptionChanged = async (object: unknown): Promise<void> => {
        const subscription = subscriptionFromEvent(object, now);
        if (subscription !== undefined) {
            await applySubscription(prisma, subscription);
        }
    };

    /* Signature-authenticated against the RAW body; a plan that is enabled but has no webhook secret refuses
     * everything with 400, that is a misconfiguration to surface, not to absorb. Unrecognized event types ack
     * with 200 so Stripe stops retrying them. */
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
            await onCheckoutCompleted(data.object);
        } else if (type === `customer.subscription.updated` || type === `customer.subscription.deleted`) {
            await onSubscriptionChanged(data.object);
        }
        return c.json({ received: true });
    });

    return app;
};
