import type { AdminOverview } from "@intentic-app/api-contract";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import { poolEnabled } from "../pool/pool-membership.js";
import { trialEnabled } from "../trial/trial-pool.js";
import { walletEnabled } from "../wallet/wallet-custody.js";
import { hostedEnabled } from "../sandbox/hosted/hosted.js";

/* The operator's glance, computed fresh on every read — counts only, no rows, so the query cost stays flat
 * no matter how the tables grow (every count below runs on an indexed column or the primary key). Nothing
 * here caches: an admin reading a number is usually reacting to something, and a stale count is exactly the
 * wrong thing to react to. */

// A daemon that announced within this window reads as connected — the same order of recency the setup
// wizard trusts `lastSeenAt` for.
const ACTIVE_DAEMON_WINDOW_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// The service lifecycle vocabulary (pool-admission.ts). Spelled here so a status the watch invents later
// shows up as a wrong TOTAL rather than silently vanishing from the panel.
const SERVICE_STATUSES = [`draft`, `probation`, `listed`, `suspended`] as const;

export const adminOverview = async (prisma: PrismaClient, config: Config, now: () => Date = () => new Date()): Promise<AdminOverview> => {
    const at = now();
    const utcMidnight = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const seenSince = (ms: number) => prisma.sandbox.count({ where: { lastSeenAt: { gte: new Date(at.getTime() - ms) } } });
    const [users, sandboxes, activeDaemons, day, week, month, membershipsByStatus, canceled30d, servicesByStatus, runsToday, hostedMachines] =
        await Promise.all([
            prisma.user.count(),
            prisma.sandbox.count(),
            seenSince(ACTIVE_DAEMON_WINDOW_MS),
            seenSince(DAY_MS),
            seenSince(7 * DAY_MS),
            seenSince(30 * DAY_MS),
            prisma.membership.groupBy({ by: [`status`], _count: { _all: true } }),
            // Churn that already happened: canceled rows whose last webhook update landed this month. The
            // update stamp is the cancellation's arrival for a status that never changes again afterwards.
            prisma.membership.count({ where: { status: `canceled`, updatedAt: { gte: new Date(at.getTime() - 30 * DAY_MS) } } }),
            prisma.service.groupBy({ by: [`status`], _count: { _all: true } }),
            prisma.serviceRun.count({ where: { createdAt: { gte: utcMidnight } } }),
            prisma.hostedMachine.count(),
        ]);
    const membershipCount = (status: string) => membershipsByStatus.find((row) => row.status === status)?._count._all ?? 0;
    const services = Object.fromEntries(
        SERVICE_STATUSES.map((status) => [status, servicesByStatus.find((row) => row.status === status)?._count._all ?? 0]),
    ) as AdminOverview[`services`];
    const active = membershipCount(`active`);
    return {
        users,
        sandboxes,
        activeDaemons,
        activeSandboxes: { day, week, month },
        memberships: {
            active,
            trialing: membershipCount(`trialing`),
            pastDue: membershipCount(`past_due`),
            canceled30d,
            // Display arithmetic, never accounting: Stripe stays the money's source of truth. Trialing rows
            // are excluded on purpose — they pay nothing yet, and PREMIUM_STATUSES is about entitlement.
            mrrUsd: active * config.pool.priceUsd,
        },
        services,
        runsToday,
        hostedMachines,
        lanes: {
            trial: trialEnabled(config),
            pool: poolEnabled(config),
            hosted: hostedEnabled(config),
            wallet: walletEnabled(config),
            push: config.apns.keyP8 !== ``,
        },
        mutationsEnabled: config.admin.mutations,
    };
};
