import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../config.js";

// The UTC day the allowance is counted in, as TrialUsage counts its own: the allowance resets at UTC midnight.
const repairUtcDay = (now: Date): string => now.toISOString().slice(0, 10);

const resetsAt = (now: Date): string => {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return next.toISOString();
};

export interface RepairAllowance {
    readonly allowance: number;
    readonly used: number;
    readonly remaining: number;
    readonly resetsAt: string;
}

export const repairStatus = async (prisma: PrismaClient, config: Config, userId: string, now: Date): Promise<RepairAllowance> => {
    const allowance = config.repair.dailyTurns;
    const day = repairUtcDay(now);
    const row = await prisma.repairUsage.findUnique({ where: { userId_day: { userId, day } } });
    const used = row?.turns ?? 0;
    return { allowance, used, remaining: Math.max(0, allowance - used), resetsAt: resetsAt(now) };
};

export const spendRepairTurn = async (
    prisma: PrismaClient,
    config: Config,
    userId: string,
    now: Date,
): Promise<RepairAllowance & { allowed: boolean }> => {
    const allowance = config.repair.dailyTurns;
    const day = repairUtcDay(now);
    const row = await prisma.repairUsage.upsert({
        where: { userId_day: { userId, day } },
        create: { userId, day, turns: 1 },
        update: { turns: { increment: 1 } },
    });
    const used = row.turns;
    return { allowance, used, remaining: Math.max(0, allowance - used), resetsAt: resetsAt(now), allowed: used <= allowance };
};

// Gives back a turn that never got an answer, as refundTrialMessage does: non-throwing, since the caller still owes its
// reply, and a refund that did not land is logged rather than dropped.
export const refundRepairTurn = async (prisma: PrismaClient, logger: Logger, userId: string, now: Date): Promise<void> => {
    const day = repairUtcDay(now);
    try {
        await prisma.repairUsage.update({ where: { userId_day: { userId, day } }, data: { turns: { decrement: 1 } } });
    } catch (error) {
        logger.error({ err: error, userId, day }, `repair: refunding an unanswered turn failed; it stays spent`);
    }
};
