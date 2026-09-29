import { FREE_TIER, isHostedTierId } from "@intentic/constants";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { DAY_MS } from "../../durations.js";
import { compedEmail, isOnPlan, paidSlotsOf, slotHolders } from "./hosted-plan.js";
import { hostedTierIn } from "./hosted-shape.js";
import { getMachineDetail, isFlyGone, LIVE_STATES } from "./fly/fly.js";
import { carriedFreeMinutes, carriedStandingOf, GOOGLE_SUBJECT_SELECT } from "./abuse/carried-standing.js";

/* THE HOUR METER. A hosted machine's awake minutes are paid for out of one of two kinds of hours, and every minute is
 * charged to exactly one of them:
 *
 *   THE ACCOUNT'S FREE HOURS: the free rung's monthly figure (@intentic/constants hosted-tiers, the operator's own in
 *   `config.hosted`), ramped for a new account, and spent by every machine of the account that does not stand on a
 *   paid slot. Released machines' minutes stay in it, so letting a machine go and asking for another never starts a
 *   fresh month.
 *
 *   A MACHINE'S OWN MONTH: its rung's figure, while it stands on a paid slot the account holds (hosted-plan.ts
 *   `slotHolders`). A slot's hours are that machine's alone, so two machines on two rungs are two ceilings and the
 *   expensive one never spends the cheap one's hours.
 *
 * A comped account's minutes are charged the same way and counted against nothing. Which hours a minute went to is
 * written on its row when it is charged (`tier`), so moving a machine or losing a plan changes what the NEXT minute
 * spends and never re-prices one already spent.
 *
 * A stretch opens at wake (the platform's own stamp) and closes later by asking Fly, since a machine stops itself from
 * inside. It counts live while open, towards the hours the machine spends now; enforced at wake, and past a grace
 * hour on the tick (hosted-meter.ts). Every stretch write locks the machine row and charges in its transaction; the
 * writers race in specs/HostedStretch.tla. */

// The calendar month a moment belongs to, UTC, as the `YYYY-MM` rows are keyed by.
export const usageMonth = (at: Date): string => at.toISOString().slice(0, 7);

// When the meter's month rolls over: the first of the next month, UTC; what every surface calls resets.
export const usageResetsAt = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

/** Which hours: the account's free ones, or one machine's own month on the paid slot it stands on. */
export type HoursKind = `free` | `slot`;

export interface HostedBudget {
    readonly kind: HoursKind;
    // The rung whose figure the ceiling is, which is also what a minute spent from these hours is recorded as: the
    // free rung's id for the account's free hours, the slot's rung for a machine's own month.
    readonly tier: string;
    // False when nothing is counted against a ceiling: a comped account, or free hours on a platform that sets none.
    readonly metered: boolean;
    // The ceiling and what is left of it, in minutes; both 0 when unmetered, so read `metered` first.
    readonly allowanceMinutes: number;
    readonly remainingMinutes: number;
    // Spent this month, live, and counted whether or not a ceiling applies: a comped account still has a month.
    readonly usedMinutes: number;
    // Set while the newcomer ramp holds the free hours down: when the account is old enough for the full figure.
    readonly rampUntil?: Date;
}

/** Every kind of hours one account has this month, read at once so that no two surfaces can disagree about any of it. */
export interface AccountHours {
    // The account's free hours: what every machine off a paid slot spends, and what a new machine arrives on.
    readonly free: HostedBudget;
    // What each of the account's machines spends, by sandbox id: the free budget itself for a machine that spends the
    // account's free hours, its own month for one on a paid slot.
    readonly machines: ReadonlyMap<string, HostedBudget>;
}

interface Ceiling {
    readonly allowanceMinutes: number;
    readonly rampUntil?: Date;
}

// One budget from what was spent and the ceiling it is held to, or none: unmetered.
const budgetOf = (kind: HoursKind, tier: string, usedMinutes: number, ceiling: Ceiling | undefined): HostedBudget =>
    ceiling === undefined
        ? { kind, tier, metered: false, allowanceMinutes: 0, remainingMinutes: 0, usedMinutes }
        : {
              kind,
              tier,
              metered: true,
              allowanceMinutes: ceiling.allowanceMinutes,
              remainingMinutes: Math.max(0, ceiling.allowanceMinutes - usedMinutes),
              usedMinutes,
              ...(ceiling.rampUntil === undefined ? {} : { rampUntil: ceiling.rampUntil }),
          };

/* THE NEWCOMER RAMP: an account younger than `hosted.newAccountDays` has `hosted.newAccountHours` as its free hours
 * instead of the month's figure. A farm of fresh accounts is the cheapest way to multiply the free lane, and ageing
 * an account is the one cost it cannot skip; a person evaluating the product spends a few hours in their first week,
 * not forty. Never raises the figure, and never touches a paid slot's hours: it is a brake on the free plan, not on a
 * purchase made on day one. */
const rampedFreeHours = (config: Config, createdAt: Date | undefined, full: number, now: Date): Ceiling => {
    const { newAccountDays, newAccountHours } = config.hosted;
    if (createdAt === undefined || newAccountDays === 0 || newAccountHours === 0) {
        return { allowanceMinutes: full };
    }
    const rampUntil = new Date(createdAt.getTime() + newAccountDays * DAY_MS);
    return rampUntil <= now ? { allowanceMinutes: full } : { allowanceMinutes: Math.min(full, newAccountHours * 60), rampUntil };
};

// Minutes since an open stretch began, towards the month it began in, which is where settling charges all of it.
const liveMinutes = (wokeAt: Date | null, month: string, now: Date): number =>
    wokeAt === null || usageMonth(wokeAt) !== month ? 0 : Math.max(0, Math.floor((now.getTime() - wokeAt.getTime()) / 60_000));

// Oldest first, ties by id: the order slotHolders decides in, so the meter and the charge read the same machines.
const OLDEST_FIRST: Prisma.HostedMachineOrderByWithRelationInput[] = [{ createdAt: `asc` }, { id: `asc` }];

/**
 * Every kind of hours this ACCOUNT has this month, live: settled rows plus open stretches, no provider call. `ownerId`
 * is always the sandbox's OWNER, never the caller, so a shared sandbox's guests spend the owner's hours. The one read
 * the Billing page, the wake, the provision gate, a build and the tick all make, so none of them can disagree. The free
 * hours include what a deleted account with the same Google subject spent this month.
 */
export const accountHoursOf = async (
    prisma: Pick<PrismaClient, "user" | "hostedPlan" | "hostedMachine" | "hostedUsage" | "hostedStanding">,
    config: Config,
    ownerId: string,
    now: Date = new Date(),
): Promise<AccountHours> => {
    const month = usageMonth(now);
    const [owner, plan, machines, rows] = await Promise.all([
        prisma.user.findUnique({ where: { id: ownerId }, select: { createdAt: true, email: true, ...GOOGLE_SUBJECT_SELECT } }),
        prisma.hostedPlan.findUnique({ where: { userId: ownerId }, select: { status: true, items: { select: { tier: true, quantity: true } } } }),
        prisma.hostedMachine.findMany({ where: { sandbox: { ownerId } }, select: { sandboxId: true, tier: true, wokeAt: true }, orderBy: OLDEST_FIRST }),
        prisma.hostedUsage.groupBy({ by: [`sandboxId`, `tier`], where: { ownerId, month }, _sum: { minutes: true } }),
    ]);
    // A paying account is a subscriber first, as the plan state reads it; the comp list answers only for the rest.
    const comped = !isOnPlan(plan) && owner !== null && compedEmail(config, owner.email);
    const holders = slotHolders(machines, paidSlotsOf(plan));
    const settled = (counts: (row: { sandboxId: string | null; tier: string }) => boolean): number =>
        rows.reduce((sum, row) => (counts(row) ? sum + (row._sum.minutes ?? 0) : sum), 0);

    const freeLive = machines.reduce((sum, machine) => (holders.has(machine.sandboxId) ? sum : sum + liveMinutes(machine.wokeAt, month, now)), 0);
    // A deleted account's free minutes this month, carried onto this one by its Google subject (carried-standing.ts):
    // deleting the account and signing in again is not a fresh month.
    const carried = carriedFreeMinutes(await carriedStandingOf(prisma, config, owner?.accounts), month);
    const freeFull = hostedTierIn(config, FREE_TIER.id).monthlyHours * 60;
    const free = budgetOf(
        `free`,
        FREE_TIER.id,
        settled((row) => row.tier === FREE_TIER.id) + freeLive + carried,
        comped || freeFull === 0 ? undefined : rampedFreeHours(config, owner?.createdAt, freeFull, now),
    );

    const perMachine = new Map<string, HostedBudget>();
    for (const machine of machines) {
        if (!holders.has(machine.sandboxId)) {
            perMachine.set(machine.sandboxId, free);
            continue;
        }
        // Every minute this machine spent on a paid slot this month, whichever paid rung it stood on at the time.
        const used = settled((row) => row.sandboxId === machine.sandboxId && row.tier !== FREE_TIER.id) + liveMinutes(machine.wokeAt, month, now);
        perMachine.set(machine.sandboxId, budgetOf(`slot`, machine.tier, used, { allowanceMinutes: hostedTierIn(config, machine.tier).monthlyHours * 60 }));
    }
    return { free, machines: perMachine };
};

/** The hours this machine spends right now, and how many are left of them. `ownerId` is always the sandbox's OWNER. */
export const hostedBudgetOf = async (
    prisma: PrismaClient,
    config: Config,
    machine: { sandboxId: string; ownerId: string },
    now: Date = new Date(),
): Promise<HostedBudget> => {
    const hours = await accountHoursOf(prisma, config, machine.ownerId, now);
    // A machine the read did not find (its row deleted mid-request) stands on no slot, so it would spend the free hours.
    return hours.machines.get(machine.sandboxId) ?? hours.free;
};

/** What a new machine would spend: it arrives on the free rung, so the account's free hours, released machines' included. */
export const hostedArrivalBudget = async (prisma: PrismaClient, config: Config, ownerId: string, now: Date = new Date()): Promise<HostedBudget> =>
    (await accountHoursOf(prisma, config, ownerId, now)).free;

// The hours a minute this machine spends right now is charged to: its own rung while it stands on a paid slot the
// account holds, the account's free hours otherwise. Read inside the charge's own transaction, by the same rule the
// meter reads with (slotHolders), so a minute is recorded as the hours it was counted against.
const chargedTierOf = async (tx: Prisma.TransactionClient, machine: { sandboxId: string; ownerId: string }): Promise<string> => {
    const own = await tx.hostedMachine.findUnique({ where: { sandboxId: machine.sandboxId }, select: { tier: true } });
    // No row, the free rung, or a rung the ladder does not know: nothing that could stand on a paid slot.
    if (own === null || own.tier === FREE_TIER.id || !isHostedTierId(own.tier)) {
        return FREE_TIER.id;
    }
    const slots = paidSlotsOf(
        await tx.hostedPlan.findUnique({ where: { userId: machine.ownerId }, select: { status: true, items: { select: { tier: true, quantity: true } } } }),
    );
    if (!slots.has(own.tier)) {
        return FREE_TIER.id;
    }
    const peers = await tx.hostedMachine.findMany({
        where: { tier: own.tier, sandbox: { ownerId: machine.ownerId } },
        select: { sandboxId: true, tier: true },
        orderBy: OLDEST_FIRST,
    });
    return slotHolders(peers, slots).has(machine.sandboxId) ? own.tier : FREE_TIER.id;
};

// Adds minutes to what they were charged to this month; an atomic upsert, so two stretches (or a build) landing on one
// row both count. Also used by an overlay build's minutes (hosted-build.ts), charged once when it ends.
export const chargeMinutes = async (
    tx: Prisma.TransactionClient,
    machine: { sandboxId: string; ownerId: string },
    month: string,
    minutes: number,
): Promise<void> => {
    if (minutes <= 0) {
        return;
    }
    const tier = await chargedTierOf(tx, machine);
    await tx.hostedUsage.upsert({
        where: { sandboxId_month_tier: { sandboxId: machine.sandboxId, month, tier } },
        create: { sandboxId: machine.sandboxId, ownerId: machine.ownerId, month, tier, minutes },
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
// (accountHoursOf reads it live); the whole stretch is attributed to the month it started in, never split.
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
