import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";

/* WHOSE ALLOWANCE A TRIAL MESSAGE SPENDS, and whether there is any left.
 *
 * The trial is metered per SIGNED-IN ACCOUNT rather than per visitor, and that choice is what makes an open
 * model endpoint survivable. A fingerprint-capped pool is farmable by clearing cookies; an account-capped one
 * costs an attacker a fresh Google account per allowance, which is the difference between a free pool and a
 * free-for-all. It also costs the honest user nothing, because everyone who reaches a sandbox has already
 * signed in — there is no extra step to add.
 *
 * The account is reached from the sandbox's connect token, which is the credential the daemon already holds and
 * already presents to /sandbox/announce. So a trial request proves "I am a sandbox intentic issued", and the
 * owner of that sandbox is who pays. */

// The UTC day an allowance is counted against. UTC rather than the user's zone deliberately: the reset has to be
// a fact the server can state without asking the client what time it thinks it is, and a client-chosen midnight
// is a client-chosen second allowance.
const trialDay = (now: Date): string => now.toISOString().slice(0, 10);

// When the current allowance resets — the next UTC midnight, as an ISO stamp the browser can render in local
// time. Derived from `now` rather than read from the row, so it is answerable before a user has spent anything.
const trialResetsAt = (now: Date): string => {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return next.toISOString();
};

export interface TrialStatus {
    // Messages per UTC day for one account — the configured allowance, restated so a caller never has to guess.
    readonly allowance: number;
    readonly used: number;
    readonly remaining: number;
    readonly resetsAt: string;
    // The real model behind the trial's single published id, on this account's most recent message. Absent until
    // one has been served today.
    readonly servedModel?: string;
}

// What this account has left today, WITHOUT spending anything — the read the daemon polls so the model picker
// can badge the trial with a real number instead of a promise. A user who has never used the trial has no row,
// which is not an error: it is a full allowance.
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

/* WHICH REAL MODEL ANSWERED, written after the fact — the trial publishes one synthetic id and routes behind
 * it, so this is the only record of what a given answer actually ran on.
 *
 * A second write rather than part of the spend, because the spend has to happen BEFORE the upstream call (it is
 * the only shape that cannot be raced) and the model is not known until after. Cheap at trial volume, which is
 * a dozen messages per account per day.
 *
 * Non-throwing: a status line is worth nothing next to the answer the user is waiting for, and the row can
 * legitimately be gone by now — a refund on a refused turn races the day rolling over. */
export const recordServedModel = async (prisma: PrismaClient, userId: string, now: Date, model: string): Promise<void> => {
    await prisma.trialUsage.update({ where: { userId_day: { userId, day: trialDay(now) } }, data: { lastModel: model } }).catch(() => undefined);
};

/* SPEND ONE MESSAGE, or refuse — one statement, because the check and the increment must not be two.
 *
 * Read-then-write is the obvious shape and the wrong one: two turns starting together both read `11 used`, both
 * decide there is room, and both write `12`, so the allowance leaks one message per concurrent pair. The upsert
 * below is atomic on the (userId, day) unique key, so the increment always lands exactly once; the refusal is
 * then decided from the value the DATABASE returned, which is the post-increment count nobody else can have
 * changed underneath.
 *
 * Refusing AFTER incrementing means a refused attempt still consumes a slot, which is deliberate: it is the only
 * version of this that can't be raced, and the effect on an honest user is nil (they are already at zero, and
 * the counter resets on the same schedule either way). */
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

// Give a refused message back. The spend is deliberately optimistic — it has to be, to stay atomic — so an
// upstream that never answered would otherwise bill the user for a turn they did not get. Floored at zero, since
// a refund can race a reset and a negative allowance would read as a bonus.
export const refundTrialMessage = async (prisma: PrismaClient, userId: string, now: Date): Promise<void> => {
    await prisma.trialUsage
        .update({ where: { userId_day: { userId, day: trialDay(now) } }, data: { messages: { decrement: 1 } } })
        .catch(() => undefined);
    await prisma.trialUsage.updateMany({ where: { userId, day: trialDay(now), messages: { lt: 0 } }, data: { messages: 0 } }).catch(() => undefined);
};
