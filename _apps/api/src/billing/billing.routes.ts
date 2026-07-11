import { apiContract } from "@intentic-app/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { getPlan, PLAN_ENTITLEMENTS } from "./entitlements.js";
import { getStripe } from "./stripe.js";

const os = implement(apiContract).$context<OrpcContext>();

export const billingRoutes = {
    // The live "pro" price for the upgrade dialog. Read straight from Stripe (the price the checkout will
    // charge), so the displayed figure can't drift. Gated behind a session like every handler; NOT_FOUND when
    // billing is unconfigured (matches the auth.ts soft-warn — the upgrade flow itself 404s until then).
    pricing: os.billing.pricing.handler(async ({ context }) => {
        requireUser(context);
        const { secretKey, proPriceId } = context.config.stripe;
        if (!secretKey || !proPriceId) {
            throw new ORPCError(`NOT_FOUND`, { message: `billing is not configured` });
        }
        const price = await getStripe(context.config).prices.retrieve(proPriceId);
        // ponytail: assumes our single fixed recurring "pro" price; tiered/metered pricing would need more.
        return { amount: price.unit_amount ?? 0, currency: price.currency, interval: price.recurring?.interval ?? `month` };
    }),
    // The caller's server-resolved tier + entitlements, for rendering upsell states early. Postgres-only
    // (works with Stripe unconfigured); the gated routes below enforce regardless of what the client shows.
    plan: os.billing.plan.handler(async ({ context }) => {
        const user = requireUser(context);
        const plan = await getPlan(context.config, context.prisma, user);
        return { plan, entitlements: PLAN_ENTITLEMENTS[plan] };
    }),
};
