import { hostedTier } from "@intentic/constants";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { DAY_MS } from "../../durations.js";
import { tierOfRow } from "./hosted-shape.js";
import { getMachine, isFlyGone, LIVE_STATES } from "./fly/fly.js";

// The hour meter: what a machine costs its month, and whether any of it is left to wake it with. A stretch opens at
// wake (the platform's own stamp) and closes later by asking Fly, since a machine stops itself from inside. Counts
// live while open; enforced at wake, past a grace hour on the tick.
//
// PER MACHINE, because the ceiling is its rung's (@intentic/constants hosted-tiers). An account holding two machines
// on two rungs has two ceilings, and an account figure is the sum of them, which is only ever a display.

// The calendar month a moment belongs to, UTC, as the `YYYY-MM` rows are keyed by.
export const usageMonth = (at: Date): string => at.toISOString().slice(0, 7);

// When the meter's month rolls over: the first of the next month, UTC; what the Billing page calls resets.
export const usageResetsAt = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

export interface HostedBudget {
    // False when unmetered entirely: a platform with the ceiling off, or a rung that has none.
    readonly metered: boolean;
    // Ceiling and what's left of it, in minutes; both 0 when unmetered, so read `metered` first.
    readonly allowanceMinutes: number;
    readonly usedMinutes: number;
    readonly remainingMinutes: number;
    // Set while the newcomer ramp holds the ceiling down: when the account is old enough for the full one.
    readonly rampUntil?: Date;
}

const unmetered: HostedBudget = { metered: false, allowanceMinutes: 0, usedMinutes: 0, remainingMinutes: 0 };

/* THE MONTH'S CEILING FOR ONE MACHINE: the free rung's is the operator's (config.hosted.monthlyHours, 0 for none),
 * every other rung's is the ladder's. */
const rungAllowance = (config: Config, tier: string): number => {
    const rung = hostedTier(tierOfRow(tier));
    return rung.priceUsd === 0 ? config.hosted.monthlyHours * 60 : rung.monthlyHours * 60;
};

/* THE NEWCOMER RAMP: an account younger than `hosted.newAccountDays` has `hosted.newAccountHours` as its
 * month's ceiling instead of the full one. A farm of fresh accounts is the cheapest way to multiply the free
 * lane, and ageing an account is the one cost it cannot skip; a person evaluating the product spends a few
 * hours in their first week, not forty. Never raises the ceiling: a ramp above the month's figure is the
 * month's figure, which is also what keeps it off a paid rung that was bought on day one. */
const rampedAllowance = async (
    prisma: Pick<PrismaClient, "user">,
    config: Config,
    userId: string,
    full: number,
    now: Date,
): Promise<{ allowanceMinutes: number; rampUntil?: Date }> => {
    const { newAccountDays, newAccountHours } = config.hosted;
    if (newAccountDays === 0 || newAccountHours === 0) {
        return { allowanceMinutes: full };
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
    const rampUntil = user === null ? undefined : new Date(user.createdAt.getTime() + newAccountDays * DAY_MS);
    if (rampUntil === undefined || rampUntil <= now) {
        return { allowanceMinutes: full };
    }
    return { allowanceMinutes: Math.min(full, newAccountHours * 60), rampUntil };
};

// Minutes this machine has spent this month, live: the settled row plus its open stretch, no provider call. An open
// stretch is attributed to the month it started in, like settling will.
export const hostedUsedMinutes = async (prisma: PrismaClient, sandboxId: string, now: Date = new Date()): Promise<number> => {
    const month = usageMonth(now);
    const [row, machine] = await Promise.all([
        prisma.hostedUsage.findUnique({ where: { sandboxId_month: { sandboxId, month } }, select: { minutes: true } }),
        prisma.hostedMachine.findUnique({ where: { sandboxId }, select: { wokeAt: true } }),
    ]);
    const wokeAt = machine?.wokeAt ?? null;
    const live = wokeAt === null || usageMonth(wokeAt) !== month ? 0 : Math.max(0, Math.floor((now.getTime() - wokeAt.getTime()) / 60_000));
    return (row?.minutes ?? 0) + live;
};

/**
 * Every awake minute this ACCOUNT has spent this month, live, including minutes whose sandbox is gone. This is the
 * figure the provision gate reads, and the orphaned rows are the point: a person who burns a free machine's hours,
 * releases it and asks for another must not start a fresh month by doing so.
 */
export const hostedOwnerMinutes = async (prisma: PrismaClient, userId: string, now: Date = new Date()): Promise<number> => {
    const month = usageMonth(now);
    const [settled, machines] = await Promise.all([
        prisma.hostedUsage.aggregate({ where: { ownerId: userId, month }, _sum: { minutes: true } }),
        prisma.hostedMachine.findMany({ where: { sandbox: { ownerId: userId }, wokeAt: { not: null } }, select: { wokeAt: true } }),
    ]);
    const live = machines.reduce((sum, machine) => {
        const wokeAt = machine.wokeAt;
        return wokeAt === null || usageMonth(wokeAt) !== month ? sum : sum + Math.max(0, Math.floor((now.getTime() - wokeAt.getTime()) / 60_000));
    }, 0);
    return (settled._sum.minutes ?? 0) + live;
};

/**
 * What a new machine for this account would be allowed, read before there is a machine to read. The ceiling is the
 * free rung's, since that is the rung an arrival lands on, and the spend is the ACCOUNT's for the reason above.
 */
export const hostedArrivalBudget = async (prisma: PrismaClient, config: Config, userId: string, now: Date = new Date()): Promise<HostedBudget> => {
    const full = config.hosted.monthlyHours * 60;
    if (full === 0) {
        return unmetered;
    }
    const [{ allowanceMinutes, rampUntil }, usedMinutes] = await Promise.all([
        rampedAllowance(prisma, config, userId, full, now),
        hostedOwnerMinutes(prisma, userId, now),
    ]);
    return {
        metered: true,
        allowanceMinutes,
        usedMinutes,
        remainingMinutes: Math.max(0, allowanceMinutes - usedMinutes),
        ...(rampUntil === undefined ? {} : { rampUntil }),
    };
};

/**
 * What this machine has left this month. `userId` is always the sandbox's OWNER, never the caller, so a shared
 * sandbox's guests spend the owner's month; the rung is the machine's own, so two machines on one account are two
 * separate ceilings.
 */
export const hostedBudgetOf = async (
    prisma: PrismaClient,
    config: Config,
    machine: { sandboxId: string; tier: string; ownerId: string },
    now: Date = new Date(),
): Promise<HostedBudget> => {
    const full = rungAllowance(config, machine.tier);
    if (full === 0) {
        return unmetered;
    }
    const [{ allowanceMinutes, rampUntil }, usedMinutes] = await Promise.all([
        rampedAllowance(prisma, config, machine.ownerId, full, now),
        hostedUsedMinutes(prisma, machine.sandboxId, now),
    ]);
    return {
        metered: true,
        allowanceMinutes,
        usedMinutes,
        remainingMinutes: Math.max(0, allowanceMinutes - usedMinutes),
        ...(rampUntil === undefined ? {} : { rampUntil }),
    };
};

/** The budget for a sandbox named by id alone, for callers that hold no machine row yet. Unmetered where none exists. */
export const hostedBudgetForSandbox = async (prisma: PrismaClient, config: Config, sandboxId: string, now: Date = new Date()): Promise<HostedBudget> => {
    const machine = await prisma.hostedMachine.findUnique({ where: { sandboxId }, select: { tier: true, sandbox: { select: { ownerId: true } } } });
    if (machine === null) {
        return unmetered;
    }
    return hostedBudgetOf(prisma, config, { sandboxId, tier: machine.tier, ownerId: machine.sandbox.ownerId }, now);
};

// Adds a settled stretch to its machine's month; atomic upsert so two racing settlements both increment. Also used by
// an overlay build's minutes (hosted-build.ts), charged once when it ends.
export const chargeMinutes = async (
    prisma: Prisma.TransactionClient,
    machine: { sandboxId: string; ownerId: string },
    month: string,
    minutes: number,
): Promise<void> => {
    if (minutes <= 0) {
        return;
    }
    await prisma.hostedUsage.upsert({
        where: { sandboxId_month: { sandboxId: machine.sandboxId, month } },
        create: { sandboxId: machine.sandboxId, ownerId: machine.ownerId, month, minutes },
        update: { minutes: { increment: minutes } },
    });
};

// Closes an open stretch if it has actually ended; safe to call on anything. A still-running machine is left open
// (hostedUsedMinutes reads it live); the whole stretch is attributed to the month it started in, never split.
export const settleHostedStretch = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    machine: { id: string; sandboxId: string; ownerId: string; appName: string; machineId: string; wokeAt: Date | null },
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
    const minutes = await closeHostedStretch(prisma, machine, state === `gone` ? undefined : state.updatedAt);
    logger.info({ app: machine.appName, minutes }, `hosted meter: stretch settled`);
};

/* CLOSE AN OPEN STRETCH WITHOUT ASKING THE PROVIDER, for the paths that already know how the machine ended: the settle above (which just asked). */
export const closeHostedStretch = async (
    prisma: Prisma.TransactionClient,
    machine: { id: string; sandboxId: string; ownerId: string; wokeAt: Date | null },
    endedAt?: Date,
): Promise<number> => {
    if (!machine.wokeAt) {
        return 0;
    }
    const now = new Date();
    const stoppedAt = endedAt !== undefined && endedAt <= now && endedAt >= machine.wokeAt ? endedAt : now;
    const minutes = Math.round((stoppedAt.getTime() - machine.wokeAt.getTime()) / 60_000);
    await chargeMinutes(prisma, machine, usageMonth(machine.wokeAt), minutes);
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
        select: { id: true, sandboxId: true, appName: true, machineId: true, wokeAt: true, sandbox: { select: { ownerId: true } } },
    });
    for (const machine of open) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential, gentle on the Fly API
        await settleHostedStretch(prisma, config, logger, { ...machine, ownerId: machine.sandbox.ownerId }).catch((error: unknown) =>
            logger.error({ err: error, app: machine.appName }, `hosted meter: settling failed; retried next tick`),
        );
    }
};
