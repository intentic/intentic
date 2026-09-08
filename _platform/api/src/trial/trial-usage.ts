import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../config.js";

// Trial allowance is metered per signed-in account, not per visitor: an account cap costs an attacker a fresh Google
// account per allowance, where a fingerprint cap is cleared with a cookie. The account is reached from the sandbox's
// connect token, the same credential the daemon already presents to /sandbox/announce.

// UTC day, not the user's zone: the reset must be a server fact, not a client-chosen midnight.
const trialDay = (now: Date): string => now.toISOString().slice(0, 10);

// Next UTC midnight as an ISO stamp, derived from `now` so it's answerable before anything is spent.
const trialResetsAt = (now: Date): string => {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return next.toISOString();
};

export interface TrialStatus {
    // Configured daily allowance, restated so a caller never has to guess it.
    readonly allowance: number;
    readonly used: number;
    readonly remaining: number;
    readonly resetsAt: string;
    // Real model behind the trial's one published id, for the account's latest message; absent until served.
    readonly servedModel?: string;
}

// What's left today without spending anything, polled for the model picker's badge; no row means a full allowance, not
// an error.
export const trialStatus = async (prisma: PrismaClient, config: Config, userId: string, now: Date): Promise<TrialStatus> => {
    const allowance = config.trial.dailyMessages;
    const row = await prisma.trialUsage.findUnique({ where: { userId_day: { userId, day: trialDay(now) } } });
    const used = row?.messages ?? 0;
    return {
        allowance,
        used,
        remaining: Math.max(0, allowance - used),
        resetsAt: trialResetsAt(now),
        ...(row?.lastModel === null || row?.lastModel === undefined ? {} : { servedModel: row.lastModel }),
    };
};

// Written after the fact: the spend must happen before the upstream call, and the model isn't known until after.
// Non-throwing — a status line matters less than the answer, and the row can legitimately be gone by a same-day refund.
export const recordServedModel = async (prisma: PrismaClient, userId: string, now: Date, model: string): Promise<void> => {
    await prisma.trialUsage.update({ where: { userId_day: { userId, day: trialDay(now) } }, data: { lastModel: model } }).catch(() => undefined);
};

// One atomic upsert, not read-then-write: two concurrent reads of "11 used" would both proceed and leak an allowance.
// Refusal is decided from the post-increment count, so a refused attempt still spends a slot — the only version that
// can't be raced.
export const spendTrialMessage = async (
    prisma: PrismaClient,
    config: Config,
    userId: string,
    now: Date,
): Promise<TrialStatus & { allowed: boolean }> => {
    const allowance = config.trial.dailyMessages;
    const day = trialDay(now);
    const row = await prisma.trialUsage.upsert({
        where: { userId_day: { userId, day } },
        create: { userId, day, messages: 1 },
        update: { messages: { increment: 1 } },
    });
    const used = row.messages;
    return { allowance, used, remaining: Math.max(0, allowance - used), resetsAt: trialResetsAt(now), allowed: used <= allowance };
};

// Gives back an optimistically-spent slot for a turn that never got an answer; floored at zero, since a refund can race
// the daily reset.
export const refundTrialMessage = async (prisma: PrismaClient, userId: string, now: Date): Promise<void> => {
    await prisma.trialUsage
        .update({ where: { userId_day: { userId, day: trialDay(now) } }, data: { messages: { decrement: 1 } } })
        .catch(() => undefined);
    await prisma.trialUsage.updateMany({ where: { userId, day: trialDay(now), messages: { lt: 0 } }, data: { messages: 0 } }).catch(() => undefined);
};
