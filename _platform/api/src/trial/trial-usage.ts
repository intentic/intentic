import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
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
    // Steps of today's turn grace still unspent (openTrialTurn); absent where the platform grants none.
    readonly grace?: number;
}

// What is left of today's turn grace, said only where there is one.
const graceLeft = (config: Config, spent: number): { grace?: number } =>
    config.trial.graceSteps === 0 ? {} : { grace: Math.max(0, config.trial.graceSteps - spent) };

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
        ...graceLeft(config, row?.graceSteps ?? 0),
    };
};

// Written after the fact: the spend must happen before the upstream call, and the model isn't known until after.
// Non-throwing, since a status line matters less than the answer; a failure is logged, never raised.
export const recordServedModel = async (prisma: PrismaClient, logger: Logger, userId: string, now: Date, model: string): Promise<void> => {
    await prisma.trialUsage
        .update({ where: { userId_day: { userId, day: trialDay(now) } }, data: { lastModel: model } })
        .catch((error: unknown) => logger.warn({ err: error, userId, model }, `trial: recording the served model failed`));
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

/* THE FINISH-THE-TURN GRACE. The allowance counts model calls, and one small task can spend all twelve halfway: the
 * tester's first task stopped mid-edit, before it showed anything (onboarding review 2026-10-18, F01). So a turn that
 * STARTS with a step left may run on past the allowance to finish, up to `trial.graceSteps` more calls a day for the
 * account. A turn that starts with nothing left earns none: the grace finishes work already under way, it is not more
 * allowance. The daemon says when a trial turn opens and closes (POST /trial/turn), since the calls themselves reach
 * this route through its translator, which carries no turn. */

// How long an opened turn earns grace if the daemon never closes it (a crash, a close lost on the way): a trial task
// runs for minutes, and the daily cap bounds the cost either way.
const GRACE_TURN_MS = 60 * 60_000;

// A trial turn opening: whether it earns the grace. Decided by one conditional update against the row, so two turns
// opening together can't both read "one step left" off a stale count.
export const openTrialTurn = async (prisma: PrismaClient, config: Config, userId: string, now: Date): Promise<boolean> => {
    if (config.trial.graceSteps === 0) {
        return false;
    }
    const day = trialDay(now);
    // A first turn of the day has no row yet, and the whole allowance.
    await prisma.trialUsage.upsert({ where: { userId_day: { userId, day } }, create: { userId, day }, update: {} });
    const opened = await prisma.trialUsage.updateMany({
        where: { userId, day, messages: { lt: config.trial.dailyMessages } },
        data: { graceOpen: { increment: 1 }, graceOpenedAt: now },
    });
    return opened.count > 0;
};

// A turn that earned the grace closing, so the next turn the account starts with nothing left can't ride it. Floored at
// zero; a close that lands on the next day's row finds nothing open and changes nothing. Non-throwing: an open the
// close never reaches stops earning at GRACE_TURN_MS.
export const closeTrialTurn = async (prisma: PrismaClient, logger: Logger, userId: string, now: Date): Promise<void> => {
    const day = trialDay(now);
    try {
        await prisma.trialUsage.updateMany({ where: { userId, day, graceOpen: { gt: 0 } }, data: { graceOpen: { decrement: 1 } } });
    } catch (error) {
        logger.warn({ err: error, userId, day }, `trial: closing a turn failed; its grace lapses on its own`);
    }
};

// One call past the allowance, granted from the grace while a turn that earned it is still open and today's grace has a
// step left. One conditional update, so concurrent calls can't overspend it.
export const spendTrialGrace = async (prisma: PrismaClient, config: Config, userId: string, now: Date): Promise<boolean> => {
    if (config.trial.graceSteps === 0) {
        return false;
    }
    const granted = await prisma.trialUsage.updateMany({
        where: {
            userId,
            day: trialDay(now),
            graceOpen: { gt: 0 },
            graceOpenedAt: { gte: new Date(now.getTime() - GRACE_TURN_MS) },
            graceSteps: { lt: config.trial.graceSteps },
        },
        data: { graceSteps: { increment: 1 } },
    });
    return granted.count > 0;
};

// Gives back an optimistically-spent slot for a turn that never got an answer; floored at zero, since a refund can race
// the daily reset. A call the grace paid for gives its grace step back too. Non-throwing, since the caller still owes
// its reply; a refund that did not land is logged.
export const refundTrialMessage = async (
    prisma: PrismaClient,
    logger: Logger,
    userId: string,
    now: Date,
    options: { readonly grace?: boolean } = {},
): Promise<void> => {
    const day = trialDay(now);
    const data = options.grace === true ? { messages: { decrement: 1 }, graceSteps: { decrement: 1 } } : { messages: { decrement: 1 } };
    try {
        await prisma.trialUsage.update({ where: { userId_day: { userId, day } }, data });
    } catch (error) {
        logger.error({ err: error, userId, day }, `trial: refunding an unserved message failed; it stays spent`);
        return;
    }
    await prisma.trialUsage
        .updateMany({ where: { userId, day, messages: { lt: 0 } }, data: { messages: 0 } })
        .catch((error: unknown) => logger.warn({ err: error, userId, day }, `trial: flooring a refunded count at zero failed`));
    if (options.grace !== true) {
        return;
    }
    try {
        await prisma.trialUsage.updateMany({ where: { userId, day, graceSteps: { lt: 0 } }, data: { graceSteps: 0 } });
    } catch (error) {
        logger.warn({ err: error, userId, day }, `trial: flooring a refunded grace count at zero failed`);
    }
};
