import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";

/* THE CREDIT METER, what a member's daily allowance has left, and the one statement that spends from it.
 * The trial meter's shape with an N-credit increment, for the trial meter's reasons: the check and the
 * increment must not be two operations, so spend is an atomic upsert on (userId, day) and the refusal is
 * decided from the value the database returned. A refused spend still landed its increment and is refunded
 * by its caller, optimistic on purpose, because it is the only version that can't be raced, and the honest
 * user it touches is already at zero.
 *
 * The allowance is config, never a row: pool.dailyCredits is the membership's cost ceiling, and a ceiling
 * that lived per-user in the database would be a price nobody published. */

const creditDay = (now: Date): string => now.toISOString().slice(0, 10);

const creditsResetAt = (now: Date): string => {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return next.toISOString();
};

export interface CreditStatus {
    readonly allowance: number;
    readonly used: number;
    readonly remaining: number;
    readonly resetsAt: string;
}

// What is left today, spending nothing, the read behind every "this costs N (M left)" surface.
export const creditStatus = async (prisma: PrismaClient, config: Config, userId: string, now: Date): Promise<CreditStatus> => {
    const allowance = config.pool.dailyCredits;
    const row = await prisma.creditSpend.findUnique({ where: { userId_day: { userId, day: creditDay(now) } } });
    const used = row?.credits ?? 0;
    return { allowance, used, remaining: Math.max(0, allowance - used), resetsAt: creditsResetAt(now) };
};

// Spend `credits`, or refuse, the post-increment count decides, so two concurrent runs can't both fit
// through the same remaining headroom.
export const spendCredits = async (
    prisma: PrismaClient,
    config: Config,
    userId: string,
    credits: number,
    now: Date,
): Promise<CreditStatus & { allowed: boolean }> => {
    const allowance = config.pool.dailyCredits;
    const day = creditDay(now);
    const row = await prisma.creditSpend.upsert({
        where: { userId_day: { userId, day } },
        create: { userId, day, credits },
        update: { credits: { increment: credits } },
    });
    const used = row.credits;
    return { allowance, used, remaining: Math.max(0, allowance - used), resetsAt: creditsResetAt(now), allowed: used <= allowance };
};

// Give credits back, a refused spend, or a provider that never answered. Floored at zero: a refund can
// race the UTC reset, and a negative meter would read as a bonus allowance.
export const refundCredits = async (prisma: PrismaClient, userId: string, credits: number, now: Date): Promise<void> => {
    const day = creditDay(now);
    await prisma.creditSpend.update({ where: { userId_day: { userId, day } }, data: { credits: { decrement: credits } } }).catch(() => undefined);
    await prisma.creditSpend.updateMany({ where: { userId, day, credits: { lt: 0 } }, data: { credits: 0 } }).catch(() => undefined);
};
