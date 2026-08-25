import type { PrismaClient } from "@intentic-app/prisma";

/* THE DAILY ROLLUP — one admin_daily_stat row per closed UTC day, written by the retention sweep, so the
 * panel's trend lines survive the sweeps that take the raw rows. WINDOW columns are exact facts about
 * yesterday (immutable timestamps: signups, runs, the trial's day-keyed meter). SNAPSHOT columns are the
 * platform as it stands at rollup time, kept because their raw signal (lastSeenAt) moves and cannot be
 * re-asked later — a boot at noon snapshots noon, which the column name says rather than hides.
 *
 * Upsert on `day`: the sweep runs at boot AND daily, so a redeploy morning would otherwise double-write.
 * `created` reports whether this run was the day's FIRST — the latch the operator digest sends on. */

const DAY_MS = 24 * 60 * 60 * 1000;

const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);

export const rollupAdminDaily = async (prisma: PrismaClient, now: () => Date = () => new Date()): Promise<{ day: string; created: boolean }> => {
    const at = now();
    const todayStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const dayStart = new Date(todayStart.getTime() - DAY_MS);
    const day = utcDayOf(dayStart);
    const [newUsers, serviceRuns, trialMessages, totalUsers, connectedUsers, activeSandboxes24h, membershipsActive, hostedMachines] = await Promise.all([
        prisma.user.count({ where: { createdAt: { gte: dayStart, lt: todayStart } } }),
        prisma.serviceRun.count({ where: { createdAt: { gte: dayStart, lt: todayStart } } }),
        prisma.trialUsage.aggregate({ where: { day }, _sum: { messages: true } }).then((aggregate) => aggregate._sum.messages ?? 0),
        prisma.user.count(),
        prisma.user.count({ where: { sandboxes: { some: { firstAnnouncedAt: { not: null } } } } }),
        prisma.sandbox.count({ where: { lastSeenAt: { gte: new Date(at.getTime() - DAY_MS) } } }),
        prisma.membership.count({ where: { status: { in: [`active`, `trialing`] } } }),
        prisma.hostedMachine.count(),
    ]);
    const stats = { newUsers, serviceRuns, trialMessages, totalUsers, connectedUsers, activeSandboxes24h, membershipsActive, hostedMachines };
    const existing = await prisma.adminDailyStat.findUnique({ where: { day }, select: { id: true } });
    await prisma.adminDailyStat.upsert({ where: { day }, create: { day, ...stats }, update: stats });
    return { day, created: existing === null };
};
