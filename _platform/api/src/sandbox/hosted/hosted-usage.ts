import type { Prisma, PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { onHostedPlan } from "./hosted-plan.js";
import { getMachine, isFlyGone, LIVE_STATES } from "./fly/fly.js";

// The free lane's hour meter: what a machine costs its owner's month, and whether any is left to wake it with. A
// stretch opens at wake (the platform's own stamp) and closes later by asking Fly, since a machine stops itself from
// inside. Counts live while open; enforced at wake, past a grace hour on the tick.

// The calendar month a moment belongs to, UTC, as the `YYYY-MM` rows are keyed by.
export const usageMonth = (at: Date): string => at.toISOString().slice(0, 7);

// When the meter's month rolls over: the first of the next month, UTC; what the Billing page calls resets.
export const usageResetsAt = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

export interface HostedBudget {
    // False when unmetered entirely: on the hosted plan, or a platform with the ceiling off.
    readonly metered: boolean;
    // Ceiling and what's left of it, in minutes; both 0 when unmetered, so read `metered` first.
    readonly allowanceMinutes: number;
    readonly usedMinutes: number;
    readonly remainingMinutes: number;
}

const unmetered: HostedBudget = { metered: false, allowanceMinutes: 0, usedMinutes: 0, remainingMinutes: 0 };

// Minutes spent this month, live: settled row plus every open stretch of the owner's machines, no provider call. An
// open stretch is attributed to the month it started in, like settling will; read even for subscribers.
export const hostedUsedMinutes = async (prisma: PrismaClient, userId: string, now: Date = new Date()): Promise<number> => {
    const month = usageMonth(now);
    const [row, open] = await Promise.all([
        prisma.hostedUsage.findUnique({ where: { userId_month: { userId, month } }, select: { minutes: true } }),
        prisma.hostedMachine.findMany({ where: { sandbox: { ownerId: userId }, wokeAt: { not: null } }, select: { wokeAt: true } }),
    ]);
    const live = open.reduce((sum, machine) => {
        if (machine.wokeAt === null || usageMonth(machine.wokeAt) !== month) {
            return sum;
        }
        return sum + Math.max(0, Math.floor((now.getTime() - machine.wokeAt.getTime()) / 60_000));
    }, 0);
    return (row?.minutes ?? 0) + live;
};

// What this owner has left this month; the plan is checked first so a subscriber never pays for a meter read. `userId`
// is always the sandbox's owner, never the caller, so a shared sandbox's guests spend the owner's month.
export const hostedBudgetOf = async (prisma: PrismaClient, config: Config, userId: string, now: Date = new Date()): Promise<HostedBudget> => {
    const allowanceMinutes = config.hosted.monthlyHours * 60;
    if (allowanceMinutes === 0 || (await onHostedPlan(prisma, config, userId))) {
        return unmetered;
    }
    const usedMinutes = await hostedUsedMinutes(prisma, userId, now);
    return { metered: true, allowanceMinutes, usedMinutes, remainingMinutes: Math.max(0, allowanceMinutes - usedMinutes) };
};

// Adds a settled stretch to its owner's month; atomic upsert so two racing settlements both increment. Also used by an
// overlay build's minutes (hosted-build.ts), charged once when it ends.
export const chargeMinutes = async (prisma: Prisma.TransactionClient, userId: string, month: string, minutes: number): Promise<void> => {
    if (minutes <= 0) {
        return;
    }
    await prisma.hostedUsage.upsert({
        where: { userId_month: { userId, month } },
        create: { userId, month, minutes },
        update: { minutes: { increment: minutes } },
    });
};

// Closes an open stretch if it has actually ended; safe to call on anything. A still-running machine is left open
// (hostedUsedMinutes reads it live); the whole stretch is attributed to the month it started in, never split.
export const settleHostedStretch = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    machine: { id: string; appName: string; machineId: string; wokeAt: Date | null },
    ownerId: string,
): Promise<void> => {
    // Falsy, not `=== null`: no column means no open stretch, and reading it as open would bill from the epoch.
    if (!machine.wokeAt) {
        return;
    }
    const state = await getMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch((error: unknown) => {
        // Gone means stopped at destruction, not unreachable; reading it as the latter left stretches open forever.
        if (isFlyGone(error)) {
            return `gone` as const;
        }
        // Fly unreachable: leave the stretch open rather than guess; the next wake or tomorrow's sweep settles it.
        logger.warn({ err: error, app: machine.appName }, `hosted meter: could not read machine state; stretch left open`);
        return undefined;
    });
    if (state === undefined || (state !== `gone` && LIVE_STATES.has(state.state))) {
        return;
    }
    // Fly's stamp of the last transition is when it stopped. A destroyed machine has no stamp left to read at
    // all, so it takes the honest ceiling closeHostedStretch falls back to: now.
    const minutes = await closeHostedStretch(prisma, machine, ownerId, state === `gone` ? undefined : state.updatedAt);
    logger.info({ app: machine.appName, minutes }, `hosted meter: stretch settled`);
};

/* CLOSE AN OPEN STRETCH WITHOUT ASKING THE PROVIDER, for the paths that already know how the machine ended:
 * the settle above (which just asked), the delete and release routes (which are about to destroy it) and the
 * idle sweep (which has just read it stopped, or found it gone). `endedAt` is the stop time when the caller
 * holds one (Fly's last-transition stamp), clamped into the stretch: a stamp before the wake, or ahead of our
 * clock (skew), is not a stop time, and now is the latest the stretch could have ended.
 *
 * Every path that drops a HostedMachine row goes through this first, because a dropped row is minutes that
 * were never charged: the used figure reads the open stretch LIVE off the row (hostedUsedMinutes), so deleting
 * the row erased them, and provision → work a day → delete → provision again was a month that never filled.
 * Answers the minutes charged. Idempotent, a machine with no open stretch is 0 and no write. */
export const closeHostedStretch = async (
    prisma: Prisma.TransactionClient,
    machine: { id: string; wokeAt: Date | null },
    ownerId: string,
    endedAt?: Date,
): Promise<number> => {
    if (!machine.wokeAt) {
        return 0;
    }
    const now = new Date();
    const stoppedAt = endedAt !== undefined && endedAt <= now && endedAt >= machine.wokeAt ? endedAt : now;
    const minutes = Math.round((stoppedAt.getTime() - machine.wokeAt.getTime()) / 60_000);
    await chargeMinutes(prisma, ownerId, usageMonth(machine.wokeAt), minutes);
    await prisma.hostedMachine.update({ where: { id: machine.id }, data: { wokeAt: null } });
    return minutes;
};

// Opens a stretch right after a successful start (a failed wake costs nothing and isn't billed). Clearing idleWarnedAt
// in the same write cancels any pending collection.
export const openHostedStretch = async (prisma: PrismaClient, machineRowId: string): Promise<void> => {
    await prisma.hostedMachine.update({ where: { id: machineRowId }, data: { wokeAt: new Date(), idleWarnedAt: null } });
};

// Hourly reconcile: settles every ended stretch, so a machine that slept doesn't sit unsettled until its owner returns.
// Sequential and best-effort; one failure doesn't cost the rest.
export const settleHostedStretches = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<void> => {
    const open = await prisma.hostedMachine.findMany({
        where: { wokeAt: { not: null } },
        select: { id: true, appName: true, machineId: true, wokeAt: true, sandbox: { select: { ownerId: true } } },
    });
    for (const machine of open) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential, gentle on the Fly API
        await settleHostedStretch(prisma, config, logger, machine, machine.sandbox.ownerId).catch((error: unknown) =>
            logger.error({ err: error, app: machine.appName }, `hosted meter: settling failed; retried next tick`),
        );
    }
};
