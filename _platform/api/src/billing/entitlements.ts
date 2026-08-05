import type { Entitlements, Plan } from "@intentic-app/api-contract";
import { ORPCError } from "@orpc/server";
import type { Config } from "../config.js";
import type { PrismaClient } from "@intentic-app/prisma";

// THE plan-gating config — the single source of truth for what each tier gets. Re-drawing the free/pro line
// later = edit this object (and the UpgradeDialog benefits copy that mirrors it); the router only ever reads
// entitlements, never plan names. `sandboxLimit` undefined = unlimited.
export const PLAN_ENTITLEMENTS: Record<Plan, Entitlements> = {
    free: { sandboxLimit: 1, sandboxSharing: false },
    pro: { sandboxSharing: true },
};

// Server-authoritative tier. Permanent-premium emails (config.permanentPremiumEmails — comp'd/test accounts)
// resolve to pro without any subscription. Otherwise reads the Subscription rows the Better Auth Stripe plugin
// persists from webhooks (referenceId = user id): any active/trialing subscription → pro (there is only one paid
// plan). Postgres-only — no Stripe call — so gating works even when billing is unconfigured (everyone is free).
export const getPlan = async (config: Config, prisma: PrismaClient, user: { id: string; email: string }): Promise<Plan> => {
    if (config.permanentPremiumEmails.includes(user.email.toLowerCase())) {
        return `pro`;
    }
    const subscription = await prisma.subscription.findFirst({
        where: { referenceId: user.id, status: { in: [`active`, `trialing`] } },
    });
    return subscription ? `pro` : `free`;
};

// The distinguishable gate error: the web opens the Upgrade dialog on code PAYMENT_REQUIRED / status 402
// instead of surfacing a raw failure.
export const paymentRequired = (message: string): ORPCError<string, unknown> => new ORPCError(`PAYMENT_REQUIRED`, { status: 402, message });
