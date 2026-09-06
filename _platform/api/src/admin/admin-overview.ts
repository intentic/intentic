import type { AdminOverview } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../config.js";
import { trialEnabled } from "../trial/trial-pool.js";
import { walletEnabled } from "../wallet/wallet-custody.js";
import { hostedEnabled } from "../sandbox/hosted/hosted.js";
import { hostedPlanEnabled } from "../sandbox/hosted/hosted-plan.js";

/* The operator's glance, computed fresh on every read — counts only, no rows, so the query cost stays flat
 * no matter how the tables grow (every count below runs on an indexed column or the primary key). Nothing
 * here caches: an admin reading a number is usually reacting to something, and a stale count is exactly the
 * wrong thing to react to. */

// A daemon that announced within this window reads as connected — the same order of recency the setup
// wizard trusts `lastSeenAt` for.
const ACTIVE_DAEMON_WINDOW_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export const adminOverview = async (prisma: PrismaClient, config: Config, now: () => Date = () => new Date()): Promise<AdminOverview> => {
    const at = now();
    const seenSince = (ms: number) => prisma.sandbox.count({ where: { lastSeenAt: { gte: new Date(at.getTime() - ms) } } });
    const [users, sandboxes, activeDaemons, day, week, month, plansByStatus, canceled30d, hostedMachines, activeSlots] = await Promise.all([
            prisma.user.count(),
            prisma.sandbox.count(),
            seenSince(ACTIVE_DAEMON_WINDOW_MS),
            seenSince(DAY_MS),
            seenSince(7 * DAY_MS),
            seenSince(30 * DAY_MS),
            prisma.hostedPlan.groupBy({ by: [`status`], _count: { _all: true } }),
            // Churn that already happened: canceled rows whose last webhook update landed this month. The
            // update stamp is the cancellation's arrival for a status that never changes again afterwards.
            prisma.hostedPlan.count({ where: { status: `canceled`, updatedAt: { gte: new Date(at.getTime() - 30 * DAY_MS) } } }),
            prisma.hostedMachine.count(),
            // Slots, not rows: a plan covering three hosted sandboxes bills three times the price.
            prisma.hostedPlan.aggregate({ where: { status: `active` }, _sum: { quantity: true } }),
        ]);
    const planCount = (status: string) => plansByStatus.find((row) => row.status === status)?._count._all ?? 0;
    const active = planCount(`active`);
    return {
        users,
        sandboxes,
        activeDaemons,
        activeSandboxes: { day, week, month },
        plans: {
            active,
            trialing: planCount(`trialing`),
            pastDue: planCount(`past_due`),
            canceled30d,
            // Display arithmetic, never accounting: Stripe stays the money's source of truth. Trialing rows
            // are excluded on purpose — they pay nothing yet, and PLAN_STATUSES is about entitlement.
            mrrUsd: (activeSlots._sum.quantity ?? 0) * config.hostedPlan.priceUsd,
        },
        hostedMachines,
        lanes: {
            trial: trialEnabled(config),
            hostedPlan: hostedPlanEnabled(config),
            hosted: hostedEnabled(config),
            wallet: walletEnabled(config),
            push: config.apns.keyP8 !== ``,
        },
        mutationsEnabled: config.admin.mutations,
    };
};
