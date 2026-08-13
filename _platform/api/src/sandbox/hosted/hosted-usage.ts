import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { premiumOf } from "../../pool/pool-membership.js";
import { getMachine } from "./fly.js";

/* THE FREE HOSTED LANE'S HOUR METER — what a machine we run costs its owner's monthly allowance, and whether
 * there is any left to wake it with.
 *
 * The asymmetry this module exists to bridge: the platform performs every WAKE, so the start of an awake
 * stretch is always ours to stamp — but the machine STOPS ITSELF from the inside (the sandbox's idle-stop
 * exits the daemon after its quiet window), and nothing tells us. So a stretch is opened on the machine row
 * at wake and closed LATER, lazily, by asking Fly when the machine actually stopped. Nothing polls: the two
 * moments anyone cares about the number — the next wake, and the daily sweep — are exactly the moments that
 * settle it.
 *
 * Why minutes rather than a running clock: the ceiling is a month's worth of hours, the meter only has to be
 * right at the granularity somebody could notice, and an integer counter per (user, month) makes the unique
 * key do the resetting — the TrialUsage pattern, one period coarser.
 *
 * Enforcement is at WAKE and nowhere else. A machine already running is never stopped for being over budget:
 * killing a box under someone's hands to sell them a membership is the version of this feature that would
 * deserve every word said about it. Running out means the NEXT visit offers the upgrade. */

// The calendar month a moment belongs to, UTC, as the `YYYY-MM` the rows are keyed by.
export const usageMonth = (at: Date): string => at.toISOString().slice(0, 7);

// Fly states in which the machine is burning money. Mirrors hosted.ts's LIVE_STATES: a machine that is
// starting has already begun to cost, and one that is replacing is a machine.
const LIVE_STATES = new Set([`created`, `starting`, `started`, `replacing`]);

export interface HostedBudget {
    // False when this owner is metered at all — a member, or a platform with the ceiling switched off.
    readonly metered: boolean;
    // The ceiling in minutes, and what is left of it. Both 0 when unmetered; read `metered` first.
    readonly allowanceMinutes: number;
    readonly usedMinutes: number;
    readonly remainingMinutes: number;
}

const unmetered: HostedBudget = { metered: false, allowanceMinutes: 0, usedMinutes: 0, remainingMinutes: 0 };

/* What this OWNER has left this month. Membership is checked first and answers immediately: members are
 * unmetered by decision, so a member never pays the cost of a Fly round-trip or a meter read to be told so.
 *
 * `userId` is always the sandbox's owner, never the caller — a shared sandbox's guests spend the owner's
 * month, which is the only reading under which sharing cannot be used to launder machine time. */
export const hostedBudgetOf = async (prisma: PrismaClient, config: Config, userId: string): Promise<HostedBudget> => {
    const allowanceMinutes = config.hosted.monthlyHours * 60;
    if (allowanceMinutes === 0 || (await premiumOf(prisma, userId))) {
        return unmetered;
    }
    const row = await prisma.hostedUsage.findUnique({
        where: { userId_month: { userId, month: usageMonth(new Date()) } },
        select: { minutes: true },
    });
    const usedMinutes = row?.minutes ?? 0;
    return { metered: true, allowanceMinutes, usedMinutes, remainingMinutes: Math.max(0, allowanceMinutes - usedMinutes) };
};

// Add a settled stretch to its owner's month. Atomic upsert on (userId, month) — two settlements racing (a
// wake and the daily sweep landing together) both increment rather than one overwriting the other.
const chargeMinutes = async (prisma: PrismaClient, userId: string, month: string, minutes: number): Promise<void> => {
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
 * daily sweep; safe to call on anything.
 *
 * A machine still running is left open — its stretch is real but unfinished, and billing it now would either
 * double-count it later or need a second stamp to remember it didn't. The consequence is that a machine which
 * never sleeps is never charged, which is exactly the gap the always-on case leaves open and which the
 * ceiling cannot close on its own; the sweep bounds it by settling every stopped machine daily, so the only
 * uncounted time belongs to machines that are, right now, awake.
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
        // Fly unreachable: leave the stretch open rather than guess. The next wake or tomorrow's sweep
        // settles it; a machine we cannot ask about is also one we cannot bill honestly.
        logger.warn({ err: error, app: machine.appName }, `hosted meter: could not read machine state; stretch left open`);
        return undefined;
    });
    if (state === undefined || LIVE_STATES.has(state.state)) {
        return;
    }
    // Fly's stamp of the last transition is when it stopped. Missing (or ahead of now, which a clock skew can
    // produce) falls back to now — the stretch is over either way, and now is the latest it could have ended.
    const now = new Date();
    const stoppedAt = state.updatedAt !== undefined && state.updatedAt <= now && state.updatedAt >= machine.wokeAt ? state.updatedAt : now;
    const minutes = Math.round((stoppedAt.getTime() - machine.wokeAt.getTime()) / 60_000);
    await chargeMinutes(prisma, ownerId, usageMonth(machine.wokeAt), minutes);
    await prisma.hostedMachine.update({ where: { id: machine.id }, data: { wokeAt: null } });
    logger.info({ app: machine.appName, minutes }, `hosted meter: stretch settled`);
};

// Open a stretch. Called immediately after a successful start — a wake that failed cost nothing and must not
// be billed, which is why this is not folded into the budget check above it. Clearing `idleWarnedAt` in the
// same write is how coming back cancels a pending collection: the machine is plainly in use again.
export const openHostedStretch = async (prisma: PrismaClient, machineRowId: string): Promise<void> => {
    await prisma.hostedMachine.update({ where: { id: machineRowId }, data: { wokeAt: new Date(), idleWarnedAt: null } });
};

/* The daily reconcile (retention.ts): settle every machine whose stretch has ended, so a box that was woken
 * once and slept an hour later does not sit uncounted until its owner happens to return. Sequential and
 * best-effort — a handful of machines at most per platform, and one failure must not cost the rest. */
export const settleHostedStretches = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<void> => {
    const open = await prisma.hostedMachine.findMany({
        where: { wokeAt: { not: null } },
        select: { id: true, appName: true, machineId: true, wokeAt: true, sandbox: { select: { ownerId: true } } },
    });
    for (const machine of open) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential, gentle on the Fly API
        await settleHostedStretch(prisma, config, logger, machine, machine.sandbox.ownerId).catch((error: unknown) =>
            logger.error({ err: error, app: machine.appName }, `hosted meter: settling failed; retried tomorrow`),
        );
    }
};
