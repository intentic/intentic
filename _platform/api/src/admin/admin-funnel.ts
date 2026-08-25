import type { AdminFunnel } from "@intentic-app/api-contract";
import type { PrismaClient } from "@intentic-app/prisma";

/* THE ACTIVATION FUNNEL — where the product loses people, stage by stage. Every stage counts DISTINCT
 * ACCOUNTS through Prisma relation filters (`sandboxes: { some: … }`), so each is a superset of the next by
 * construction and the panel can render per-stage conversion as a subtraction.
 *
 * `setupEngaged` is the union of the lanes' different stamps on purpose: the command lane claims a setup
 * code, the hosted lane creates a machine and claims nothing, and a daemon that announced proves engagement
 * whatever the lane. Anything narrower silently undercounts a whole lane. */

const DAY_MS = 24 * 60 * 60 * 1000;

const SERIES_DAYS = 30;

const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);

export const adminFunnel = async (prisma: PrismaClient, now: () => Date = () => new Date()): Promise<AdminFunnel> => {
    const at = now();
    const utcMidnight = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const seriesStart = new Date(utcMidnight.getTime() - (SERIES_DAYS - 1) * DAY_MS);
    const [total, today, last7, last30, recentSignups, withSandbox, setupEngaged, connected, activeLast7] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { createdAt: { gte: utcMidnight } } }),
        prisma.user.count({ where: { createdAt: { gte: new Date(at.getTime() - 7 * DAY_MS) } } }),
        prisma.user.count({ where: { createdAt: { gte: new Date(at.getTime() - 30 * DAY_MS) } } }),
        // The raw stamps of the window, bucketed here: 30 days of signups is a bounded read at this
        // platform's scale, and a JS bucket beats teaching Prisma date_trunc.
        prisma.user.findMany({ where: { createdAt: { gte: seriesStart } }, select: { createdAt: true } }),
        prisma.user.count({ where: { sandboxes: { some: {} } } }),
        prisma.user.count({
            where: {
                sandboxes: {
                    some: {
                        OR: [{ setupCodeClaimedAt: { not: null } }, { hosted: { isNot: null } }, { lastSeenAt: { not: null } }],
                    },
                },
            },
        }),
        prisma.user.count({ where: { sandboxes: { some: { lastSeenAt: { not: null } } } } }),
        prisma.user.count({ where: { sandboxes: { some: { lastSeenAt: { gte: new Date(at.getTime() - 7 * DAY_MS) } } } } }),
    ]);
    // Exactly SERIES_DAYS entries, zero-filled, oldest first — the chart never has to guess at gaps.
    const buckets = new Map<string, number>();
    for (let index = 0; index < SERIES_DAYS; index += 1) {
        buckets.set(utcDayOf(new Date(seriesStart.getTime() + index * DAY_MS)), 0);
    }
    for (const signup of recentSignups) {
        const day = utcDayOf(signup.createdAt);
        const count = buckets.get(day);
        if (count !== undefined) {
            buckets.set(day, count + 1);
        }
    }
    return {
        signups: { today, last7, last30, total },
        signupSeries: [...buckets.entries()].map(([day, count]) => ({ day, count })),
        funnel: { accounts: total, withSandbox, setupEngaged, connected, activeLast7 },
    };
};
