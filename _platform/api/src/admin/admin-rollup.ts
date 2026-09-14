import type { PrismaClient } from "@intentic/prisma";
import { DAY_MS } from "../durations.js";

/* THE DAILY ROLLUP — one admin_daily_stat row per closed UTC day, written by the retention sweep. */

const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);

export const rollupAdminDaily = async (prisma: PrismaClient, now: () => Date = () => new Date()): Promise<{ day: string; created: boolean }> => {
    const at = now();
    const todayStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const dayStart = new Date(todayStart.getTime() - DAY_MS);
    const day = utcDayOf(dayStart);
    const [newUsers, trialMessages, totalUsers, connectedUsers, activeSandboxes24h, plansActive, hostedMachines] = await Promise.all([
        prisma.user.count({ where: { createdAt: { gte: dayStart, lt: todayStart } } }),
        prisma.trialUsage.aggregate({ where: { day }, _sum: { messages: true } }).then((aggregate) => aggregate._sum.messages ?? 0),
        prisma.user.count(),
        prisma.user.count({ where: { sandboxes: { some: { firstAnnouncedAt: { not: null } } } } }),
        prisma.sandbox.count({ where: { lastSeenAt: { gte: new Date(at.getTime() - DAY_MS) } } }),
        prisma.hostedPlan.count({ where: { status: { in: [`active`, `trialing`] } } }),
        prisma.hostedMachine.count(),
    ]);
    const stats = { newUsers, trialMessages, totalUsers, connectedUsers, activeSandboxes24h, plansActive, hostedMachines };
    const existing = await prisma.adminDailyStat.findUnique({ where: { day }, select: { id: true } });
    await prisma.adminDailyStat.upsert({ where: { day }, create: { day, ...stats }, update: stats });
    return { day, created: existing === null };
};
