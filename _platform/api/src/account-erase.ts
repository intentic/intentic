import { FREE_TIER } from "@intentic/constants";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { STANDING_RETENTION_MS, standingSubjectHash } from "./sandbox/hosted/abuse/carried-standing.js";
import { destroyQueuedApps, lockHostedSandbox, queueHostedTeardown } from "./sandbox/hosted/hosted-cleanup.js";
import { eraseStripeCustomer, queueStripeErasure } from "./sandbox/hosted/hosted-plan.js";
import type { StripeGateway } from "./sandbox/hosted/hosted-plan-stripe.js";
import { accountHoursOf, usageMonth } from "./sandbox/hosted/hosted-usage.js";

/* THE ONE WAY AN ACCOUNT IS ERASED, before its user row goes: the owner's own deletion (Better Auth's `beforeDelete`,
 * auth.ts) and an operator's (admin-actions.ts) both call this, and the caller deletes the user row after it.
 *
 * Everything the cascade would lose track of is written down first, in one transaction:
 *   - every hosted Fly app the account owns (live machines, trashed sandboxes still inside their undo window, a
 *     release's held volume, a provision in flight) goes to the HostedCleanup queue due now, which the cleanup sweep
 *     works through every minute and which the orphan reaper's safety caps never hold back;
 *   - the Stripe customer and subscription go to `stripe_erasure`;
 *   - the hosted standing (suspension, strike count, this month's free minutes) is MOVED onto the record keyed by the
 *     Google subject's keyed hash (carried-standing.ts), so signing in again does not start clean;
 *   - the sandboxes and trash rows are deleted, so a provision still in flight finds its sandbox gone and cleans up
 *     after itself instead of handing a machine to an account being erased.
 * Then, best-effort, the apps are destroyed and the Stripe customer deleted at once, which is what makes "immediately"
 * true in the normal case; whatever fails stays queued for its sweep.
 *
 * Safe to run again after a failure anywhere: the queues are upserts, and the standing is moved rather than copied,
 * so a second run finds only what the first one carried and writes it back unchanged. */

export interface AccountErasure {
    // Every app queued for teardown, and those confirmed destroyed by the time the call returned.
    readonly apps: readonly string[];
    readonly destroyed: readonly string[];
    // The account's Stripe customer: none, deleted now, or queued for the daily sweep.
    readonly stripe: `none` | `erased` | `queued`;
    // Whether a hosted-standing record was written for the account's Google subject.
    readonly carried: boolean;
}

// The latest of the moments a standing was last changed at, or null when there are none.
const latest = (moments: readonly (Date | null | undefined)[]): Date | null =>
    moments.reduce<Date | null>((best, at) => (at != null && (best === null || at > best) ? at : best), null);

/* Moves the account's hosted standing onto its Google subject's record. Returns whether a record was written: an
 * account with no Google sign-in has nothing to key it on, and one in good standing with no free minutes this month
 * has nothing to carry. */
const carryStanding = async (tx: Prisma.TransactionClient, config: Config, userId: string, now: Date): Promise<boolean> => {
    const account = await tx.account.findFirst({ where: { userId, providerId: `google` }, select: { accountId: true } });
    if (account === null) {
        return false;
    }
    const subjectHash = standingSubjectHash(config, account.accountId);
    const month = usageMonth(now);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { hostedSuspendedAt: true } });
    // The watch's strikes that count towards a suspension, over the window the record itself is kept for.
    const strikes = await tx.hostedStrike.findMany({
        where: { userId, action: { in: [`stopped`, `suspended`] }, createdAt: { gte: new Date(now.getTime() - STANDING_RETENTION_MS) } },
        select: { createdAt: true },
    });
    const carried = await tx.hostedStanding.findUnique({ where: { subjectHash } });
    // This month's free minutes as the meter counts them: settled, open stretches, and a record already carried.
    const hours = await accountHoursOf(tx, config, userId, now);
    const suspendedAt = user?.hostedSuspendedAt ?? carried?.suspendedAt ?? null;
    const strikeCount = strikes.length + (carried?.strikes ?? 0);
    const freeMinutes = hours.free.usedMinutes;
    const standingAt = suspendedAt === null && strikeCount === 0 ? null : latest([user?.hostedSuspendedAt, carried?.standingAt, ...strikes.map((row) => row.createdAt)]);
    if (standingAt === null && freeMinutes === 0) {
        return false;
    }
    const record = { suspendedAt, strikes: strikeCount, standingAt, month: freeMinutes === 0 ? null : month, freeMinutes };
    await tx.hostedStanding.upsert({ where: { subjectHash }, create: { subjectHash, ...record }, update: record });
    // Moved, not copied: a second run of this erase must find nothing of the account's own left to add again.
    await tx.hostedStrike.deleteMany({ where: { userId } });
    await tx.hostedUsage.deleteMany({ where: { ownerId: userId, month, tier: FREE_TIER.id } });
    await tx.user.update({ where: { id: userId }, data: { hostedSuspendedAt: null, hostedSuspendedReason: null } });
    return true;
};

export const eraseAccount = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    userId: string,
    // Injectable so tests drive Stripe without it, as in the plan routes.
    opts: { readonly gateway?: StripeGateway; readonly now?: Date } = {},
): Promise<AccountErasure> => {
    const now = opts.now ?? new Date();
    const { apps, stripe, carried } = await prisma.$transaction(async (tx) => {
        // In id order, the one order every erase takes them in; each is the lock a provision's handoff and a release take.
        const sandboxes = await tx.sandbox.findMany({ where: { ownerId: userId }, select: { id: true }, orderBy: { id: `asc` } });
        for (const sandbox of sandboxes) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- row locks, taken one after another in a fixed order
            await lockHostedSandbox(tx, sandbox.id);
        }
        const machines = await tx.hostedMachine.findMany({ where: { sandbox: { ownerId: userId } }, select: { appName: true } });
        const trashed = await tx.sandboxTrash.findMany({ where: { ownerId: userId, appName: { not: null } }, select: { appName: true } });
        // A provision in flight and a released machine's held volume are named by nothing of the account's but its
        // provision rows; the ones with a teardown already queued are the ones still standing.
        const provisioned = await tx.hostedProvision.findMany({ where: { userId }, select: { appName: true } });
        const held = await tx.hostedCleanup.findMany({ where: { appName: { in: provisioned.map((row) => row.appName) } }, select: { appName: true } });
        const names = [...new Set([...machines, ...trashed, ...held].map((row) => row.appName).filter((name): name is string => name !== null))];
        await queueHostedTeardown(tx, names, now);
        const queued = await queueStripeErasure(tx, userId);
        const wrote = await carryStanding(tx, config, userId, now);
        await tx.sandboxTrash.deleteMany({ where: { ownerId: userId } });
        await tx.sandbox.deleteMany({ where: { ownerId: userId } });
        return { apps: names, stripe: queued, carried: wrote };
    });
    const destroyed = await destroyQueuedApps(prisma, config, logger, apps);
    const erased = stripe === undefined ? undefined : await eraseStripeCustomer(prisma, config, logger, stripe, opts.gateway);
    const outcome: AccountErasure = { apps, destroyed, stripe: erased === undefined ? `none` : erased ? `erased` : `queued`, carried };
    logger.info({ userId, ...outcome }, `account erase: hosted apps, Stripe customer and standing handled before the account goes`);
    return outcome;
};
