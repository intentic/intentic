import { hostedTier } from "@intentic/constants";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { DAY_MS } from "../../durations.js";
import { tierOfRow } from "./hosted-shape.js";
import { getMachineDetail, isFlyGone, LIVE_STATES } from "./fly/fly.js";

// The hour meter: what a machine costs its month, and whether any of it is left to wake it with. A stretch opens at
// wake (the platform's own stamp) and closes later by asking Fly, since a machine stops itself from inside. Counts
// live while open; enforced at wake, past a grace hour on the tick.
//
// PER MACHINE, because the ceiling is its rung's (@intentic/constants hosted-tiers). An account holding two machines
// on two rungs has two ceilings, and an account figure is the sum of them, which is only ever a display.
//
// Every stretch write locks the machine row and charges in its transaction; the writers race in specs/HostedStretch.tla.

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

// Adds minutes to a machine's month; an atomic upsert, so two stretches (or a build) landing on one row both count.
// Also used by an overlay build's minutes (hosted-build.ts), charged once when it ends.
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

// Locks the machine row until the transaction ends and reads its open stretch; null once the row is gone.
const lockedStretch = async (tx: Prisma.TransactionClient, id: string): Promise<{ wokeAt: Date | null } | null> => {
    await tx.$queryRaw`SELECT id FROM hosted_machine WHERE id = ${id} FOR UPDATE`;
    return tx.hostedMachine.findUnique({ where: { id }, select: { wokeAt: true } });
};

// Charges a stretch to the month it began in, up to `endedAt` when that falls inside it, else up to now.
const chargeStretch = async (tx: Prisma.TransactionClient, machine: { sandboxId: string; ownerId: string }, wokeAt: Date, endedAt?: Date): Promise<number> => {
    const now = new Date();
    const stoppedAt = endedAt !== undefined && endedAt <= now && endedAt >= wokeAt ? endedAt : now;
    const minutes = Math.round((stoppedAt.getTime() - wokeAt.getTime()) / 60_000);
    await chargeMinutes(tx, machine, usageMonth(wokeAt), minutes);
    return minutes;
};

// Closes an open stretch if it has actually ended; safe to call on anything. A still-running machine is left open
// (hostedUsedMinutes reads it live); the whole stretch is attributed to the month it started in, never split.
export const settleHostedStretch = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    machine: { id: string; sandboxId: string; ownerId: string; appName: string; machineId: string; wokeAt: Date | null; tier?: string; memoryMb?: number },
): Promise<void> => {
    // Falsy, not `=== null`: no column means no open stretch, and reading it as open would bill from the epoch.
    if (!machine.wokeAt) {
        return;
    }
    // The DETAIL rather than the bare state: the same round trip, and it also carries how the machine ended. A
    // machine the kernel killed for memory is the one fact nothing else on the platform can see.
    const state = await getMachineDetail(config.hosted.flyApiToken, machine.appName, machine.machineId).catch((error: unknown) => {
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
    // all, so it takes the honest ceiling chargeStretch falls back to: now.
    const minutes = await closeHostedStretch(prisma, machine, state === `gone` ? undefined : state.updatedAt);
    // Another writer settled or replaced this stretch after it was read; how it ended is that writer's to record.
    if (minutes === undefined) {
        return;
    }
    if (state !== `gone` && state.oomKilled) {
        await recordHostedOom(prisma, logger, machine);
    }
    logger.info({ app: machine.appName, minutes }, `hosted meter: stretch settled`);
};

/* THE MACHINE WAS KILLED FOR MEMORY, as the provider reported it. Written by the settle that closed the stretch, so
 * once per stretch however many settles race; the rung and memory are the ones it HAD, because a later resize is
 * exactly what makes the old figure the interesting one. Never throws: the stretch it follows is already closed. */
const recordHostedOom = async (
    prisma: PrismaClient,
    logger: Logger,
    machine: { id: string; sandboxId: string; tier?: string; memoryMb?: number },
): Promise<void> => {
    const row = await prisma.hostedMachine
        .findUnique({ where: { id: machine.id }, select: { tier: true, memoryMb: true } })
        .catch(() => null);
    const tier = machine.tier ?? row?.tier;
    const memoryMb = machine.memoryMb ?? row?.memoryMb;
    if (tier === undefined || memoryMb === undefined) {
        return;
    }
    await prisma.hostedOom
        .create({ data: { hostedMachineId: machine.id, sandboxId: machine.sandboxId, tier, memoryMb } })
        .then(() => logger.warn({ sandboxId: machine.sandboxId, tier, memoryMb }, `hosted meter: the machine was killed for running out of memory`))
        .catch((error: unknown) => logger.error({ err: error, sandboxId: machine.sandboxId }, `hosted meter: recording an OOM failed`));
};

/** How many times this sandbox's machine has been killed for memory since `since`; what the upgrade line states. */
export const hostedOomsSince = async (prisma: PrismaClient, sandboxId: string, since: Date): Promise<number> =>
    prisma.hostedOom.count({ where: { sandboxId, at: { gte: since } } });

// Closes the stretch the caller read, only while the row still holds it; undefined when it no longer does.
export const closeHostedStretch = async (
    prisma: PrismaClient,
    machine: { id: string; sandboxId: string; ownerId: string; wokeAt: Date | null },
    endedAt?: Date,
): Promise<number | undefined> => {
    const { wokeAt } = machine;
    if (!wokeAt) {
        return undefined;
    }
    return prisma.$transaction(async (tx) => {
        const row = await lockedStretch(tx, machine.id);
        if (row?.wokeAt?.getTime() !== wokeAt.getTime()) {
            return undefined;
        }
        const minutes = await chargeStretch(tx, machine, wokeAt, endedAt);
        await tx.hostedMachine.update({ where: { id: machine.id }, data: { wokeAt: null } });
        return minutes;
    });
};

// Opens a stretch at a start that succeeded, charging the one the row still holds; false when the row is gone.
// Clearing idleWarnedAt in the same write cancels any pending collection.
export const openHostedStretch = async (prisma: PrismaClient, machine: { id: string; sandboxId: string; ownerId: string }): Promise<boolean> =>
    prisma.$transaction(async (tx) => {
        const row = await lockedStretch(tx, machine.id);
        if (!row) {
            return false;
        }
        if (row.wokeAt) {
            await chargeStretch(tx, machine, row.wokeAt);
        }
        await tx.hostedMachine.update({ where: { id: machine.id }, data: { wokeAt: new Date(), idleWarnedAt: null } });
        return true;
    });

// Deletes the row, charging the stretch it holds at that moment; runs in the caller's transaction, which keeps the lock.
export const dropHostedMachine = async (
    tx: Prisma.TransactionClient,
    machine: { id: string; sandboxId: string; ownerId: string },
    endedAt?: Date,
): Promise<void> => {
    const row = await lockedStretch(tx, machine.id);
    if (!row) {
        return;
    }
    if (row.wokeAt) {
        await chargeStretch(tx, machine, row.wokeAt, endedAt);
    }
    await tx.hostedMachine.delete({ where: { id: machine.id } });
};

// Hourly reconcile: settles every ended stretch, so a machine that slept doesn't sit unsettled until its owner returns.
// Sequential and best-effort; one failure doesn't cost the rest.
export const settleHostedStretches = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<void> => {
    const open = await prisma.hostedMachine.findMany({
        where: { wokeAt: { not: null } },
        select: { id: true, sandboxId: true, tier: true, memoryMb: true, appName: true, machineId: true, wokeAt: true, sandbox: { select: { ownerId: true } } },
    });
    for (const machine of open) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential, gentle on the Fly API
        await settleHostedStretch(prisma, config, logger, { ...machine, ownerId: machine.sandbox.ownerId }).catch((error: unknown) =>
            logger.error({ err: error, app: machine.appName }, `hosted meter: settling failed; retried next tick`),
        );
    }
};
