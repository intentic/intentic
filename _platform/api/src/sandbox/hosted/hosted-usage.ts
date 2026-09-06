import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { onHostedPlan } from "./hosted-plan.js";
import { getMachine, isFlyGone } from "./fly.js";

/* THE FREE HOSTED LANE'S HOUR METER, what a machine we run costs its owner's monthly allowance, and whether
 * there is any left to wake it with.
 *
 * The asymmetry this module exists to bridge: the platform performs every WAKE, so the start of an awake
 * stretch is always ours to stamp, but the machine STOPS ITSELF from the inside (the sandbox's idle-stop
 * exits the daemon after its quiet window), and nothing tells us. So a stretch is opened on the machine row
 * at wake and closed LATER, by asking Fly when the machine actually stopped: at the next wake, and on the
 * hourly meter tick (hosted-meter.ts).
 *
 * AN OPEN STRETCH COUNTS WHILE IT IS OPEN. The used figure is the settled row plus, for every machine of the
 * owner's that is up right now, the minutes since it woke. It used to be the settled row alone, which read
 * "40 h left" over a machine that had been awake for 39 of them, and which made the ceiling a cap on STOPPING
 * rather than on hours: a machine that never stopped was never charged, and stopping is decided inside the
 * box, where the owner is root. Counting live closes the first half; the meter tick's stop closes the second.
 *
 * Why minutes rather than a running clock: the ceiling is a month's worth of hours, the meter only has to be
 * right at the granularity somebody could notice, and an integer counter per (user, month) makes the unique
 * key do the resetting, the TrialUsage pattern, one period coarser.
 *
 * Enforcement is at WAKE, and past a grace hour on the tick. A machine is never stopped the minute its month
 * runs out under someone's hands: the editor's meter reads zero and its strip has said so first, the grace is
 * the platform's side of that promise, and the only machines the tick ever stops are ones an hour past a
 * ceiling everybody could see. Running out means the NEXT visit offers the plan. */

// The calendar month a moment belongs to, UTC, as the `YYYY-MM` the rows are keyed by.
export const usageMonth = (at: Date): string => at.toISOString().slice(0, 7);

// When the month the meter is keyed by rolls over: the first of the next month, UTC. What the Billing page
// says after "resets".
export const usageResetsAt = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

// Fly states in which the machine is burning money. Mirrors hosted.ts's LIVE_STATES: a machine that is
// starting has already begun to cost, and one that is replacing is a machine. Exported for the meter tick,
// which asks the same question before it stops anything.
export const LIVE_STATES = new Set([`created`, `starting`, `started`, `replacing`]);

export interface HostedBudget {
    // False when this owner is not metered at all: on the hosted plan, or a platform with the ceiling off.
    readonly metered: boolean;
    // The ceiling in minutes, and what is left of it. Both 0 when unmetered; read `metered` first.
    readonly allowanceMinutes: number;
    readonly usedMinutes: number;
    readonly remainingMinutes: number;
}

const unmetered: HostedBudget = { metered: false, allowanceMinutes: 0, usedMinutes: 0, remainingMinutes: 0 };

/* THE MINUTES THIS OWNER HAS SPENT THIS MONTH, live: the settled row plus the open stretch of every machine of
 * theirs that is up right now, no provider call. An open stretch is attributed to the month it started in,
 * exactly as settling attributes it, so the live figure and the one it will become agree. Read for everyone,
 * metered or not: the Billing page shows a subscriber their awake hours too, with no ceiling beside them. */
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

/* What this OWNER has left this month. The plan is checked first and answers immediately: the plan is
 * unmetered by decision, so a subscriber never pays the cost of a Fly round-trip or a meter read to be told so.
 *
 * `userId` is always the sandbox's owner, never the caller, a shared sandbox's guests spend the owner's
 * month, which is the only reading under which sharing cannot be used to launder machine time. */
export const hostedBudgetOf = async (prisma: PrismaClient, config: Config, userId: string, now: Date = new Date()): Promise<HostedBudget> => {
    const allowanceMinutes = config.hosted.monthlyHours * 60;
    if (allowanceMinutes === 0 || (await onHostedPlan(prisma, config, userId))) {
        return unmetered;
    }
    const usedMinutes = await hostedUsedMinutes(prisma, userId, now);
    return { metered: true, allowanceMinutes, usedMinutes, remainingMinutes: Math.max(0, allowanceMinutes - usedMinutes) };
};

// Add a settled stretch to its owner's month. Atomic upsert on (userId, month), two settlements racing (a
// wake and the daily sweep landing together) both increment rather than one overwriting the other. Exported
// for the one other thing that spends an owner's month: an overlay build's minutes (hosted-build.ts), charged
// once when the build ends, so a free account's builds draw on the same hours its sandbox does.
export const chargeMinutes = async (prisma: PrismaClient, userId: string, month: string, minutes: number): Promise<void> => {
    if (minutes <= 0) {
        return;
    }
    await prisma.hostedUsage.upsert({
        where: { userId_month: { userId, month } },
        create: { userId, month, minutes },
        update: { minutes: { increment: minutes } },
    });
};

/* CLOSE AN OPEN STRETCH, if there is one and if it has actually ended. Called before every wake and by the
 * hourly meter tick; safe to call on anything.
 *
 * A machine still running is left open, its stretch is real but unfinished, and settling it now would either
 * double-count it later or need a second stamp to remember it didn't. It is not uncounted meanwhile:
 * hostedUsedMinutes reads the open stretch live, so the only thing waiting on the stop is the row.
 *
 * The whole stretch is attributed to the month it STARTED in. A stretch spanning midnight on the 1st is rare,
 * bounded by the idle window, and splitting it would buy accuracy nobody can perceive at the cost of the one
 * property that makes this table trivial to reason about: one row per month, incremented, never recomputed. */
export const settleHostedStretch = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    machine: { id: string; appName: string; machineId: string; wokeAt: Date | null },
    ownerId: string,
): Promise<void> => {
    // Falsy rather than `=== null`: a caller that selected the row without this column has no open stretch to
    // close either, and reading that as "open, start unknown" would bill from the epoch.
    if (!machine.wokeAt) {
        return;
    }
    const state = await getMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch((error: unknown) => {
        /* A machine Fly says does not exist is a stretch that ended, not one we cannot read: it stopped when
         * it was destroyed, and there is nothing left to ask. Reading that as "unreachable" is what left open
         * stretches on every destroyed machine, so the same warning repeated daily forever and the owner's
         * month kept an hour that ended weeks ago. `undefined` state below still means the honest "leave it". */
        if (isFlyGone(error)) {
            return `gone` as const;
        }
        // Fly unreachable: leave the stretch open rather than guess. The next wake or tomorrow's sweep
        // settles it; a machine we cannot ask about is also one we cannot bill honestly.
        logger.warn({ err: error, app: machine.appName }, `hosted meter: could not read machine state; stretch left open`);
        return undefined;
    });
    if (state === undefined || (state !== `gone` && LIVE_STATES.has(state.state))) {
        return;
    }
    // Fly's stamp of the last transition is when it stopped. Missing (or ahead of now, which a clock skew can
    // produce) falls back to now, the stretch is over either way, and now is the latest it could have ended.
    // A destroyed machine has no stamp left to read at all, so it takes the same honest ceiling.
    const now = new Date();
    const lastTransition = state === `gone` ? undefined : state.updatedAt;
    const stoppedAt = lastTransition !== undefined && lastTransition <= now && lastTransition >= machine.wokeAt ? lastTransition : now;
    const minutes = Math.round((stoppedAt.getTime() - machine.wokeAt.getTime()) / 60_000);
    await chargeMinutes(prisma, ownerId, usageMonth(machine.wokeAt), minutes);
    await prisma.hostedMachine.update({ where: { id: machine.id }, data: { wokeAt: null } });
    logger.info({ app: machine.appName, minutes }, `hosted meter: stretch settled`);
};

// Open a stretch. Called immediately after a successful start, a wake that failed cost nothing and must not
// be billed, which is why this is not folded into the budget check above it. Clearing `idleWarnedAt` in the
// same write is how coming back cancels a pending collection: the machine is plainly in use again.
export const openHostedStretch = async (prisma: PrismaClient, machineRowId: string): Promise<void> => {
    await prisma.hostedMachine.update({ where: { id: machineRowId }, data: { wokeAt: new Date(), idleWarnedAt: null } });
};

/* The hourly reconcile (hosted-meter.ts): settle every machine whose stretch has ended, so a box that was woken
 * once and slept an hour later does not sit unsettled until its owner happens to return. Sequential and
 * best-effort, a handful of machines at most per platform, and one failure must not cost the rest. */
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
