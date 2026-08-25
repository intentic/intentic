import type { AdminOverview } from "@intentic-app/api-contract";
import type { PrismaClient } from "@intentic-app/prisma";
import { PREMIUM_STATUSES } from "../pool/pool-membership.js";

/* The operator's glance, computed fresh on every read — counts only, no rows, so the query cost stays flat
 * no matter how the tables grow (every count below runs on an indexed column or the primary key). Nothing
 * here caches: an admin reading a number is usually reacting to something, and a stale count is exactly the
 * wrong thing to react to. */

// A daemon that announced within this window reads as connected — the same order of recency the setup
// wizard trusts `lastSeenAt` for.
const ACTIVE_DAEMON_WINDOW_MS = 5 * 60 * 1000;

// The service lifecycle vocabulary (pool-admission.ts). Spelled here so a status the watch invents later
// shows up as a wrong TOTAL rather than silently vanishing from the panel.
const SERVICE_STATUSES = [`draft`, `probation`, `listed`, `suspended`] as const;

export const adminOverview = async (prisma: PrismaClient, now: () => Date = () => new Date()): Promise<AdminOverview> => {
    const at = now();
    const utcMidnight = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const [users, sandboxes, activeDaemons, activeMemberships, servicesByStatus, runsToday, hostedMachines] = await Promise.all([
        prisma.user.count(),
        prisma.sandbox.count(),
        prisma.sandbox.count({ where: { lastSeenAt: { gte: new Date(at.getTime() - ACTIVE_DAEMON_WINDOW_MS) } } }),
        // The premium rule verbatim (pool-membership.ts): active and trialing count, past_due does not.
        prisma.membership.count({ where: { status: { in: [...PREMIUM_STATUSES] } } }),
        prisma.service.groupBy({ by: [`status`], _count: { _all: true } }),
        prisma.serviceRun.count({ where: { createdAt: { gte: utcMidnight } } }),
        prisma.hostedMachine.count(),
    ]);
    const services = Object.fromEntries(
        SERVICE_STATUSES.map((status) => [status, servicesByStatus.find((row) => row.status === status)?._count._all ?? 0]),
    ) as AdminOverview[`services`];
    return { users, sandboxes, activeDaemons, activeMemberships, services, runsToday, hostedMachines };
};
