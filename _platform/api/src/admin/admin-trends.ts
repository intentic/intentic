import type { AdminTrends } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";

// The panel's read of the rollup rows: newest 90 days, served oldest-first so a chart draws left to right.
const TREND_DAYS = 90;

export const adminTrends = async (prisma: PrismaClient): Promise<AdminTrends> => {
    const rows = await prisma.adminDailyStat.findMany({
        orderBy: { day: `desc` },
        take: TREND_DAYS,
        select: {
            day: true,
            newUsers: true,
            trialMessages: true,
            totalUsers: true,
            connectedUsers: true,
            activeSandboxes24h: true,
            plansActive: true,
            hostedMachines: true,
        },
    });
    return { days: rows.toReversed() };
};
