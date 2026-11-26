import { hostedTier, isHostedTierId } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../../config.js";
import { MINUTE_MS } from "../../../durations.js";
import { JOB_HOSTED_PLAN, runExclusive } from "../../../jobs-lock.js";
import { hostedEnabled } from "../hosted.js";
import { migrateHosted } from "../migrate/hosted-migrate.js";
import { isPaidTier } from "./plan-change.js";

/* APPLIES A SANDBOX'S WAITING PLAN CHANGE TO ITS MACHINE: the resize an upgrade was paid for (started at once by the
 * route or the checkout webhook, in the background), and the downgrade a renewal date brought (this module's job). A
 * resize that fails leaves the change waiting, and the job tries it again; nothing here bills anything. */

// How often the job looks for due changes: a downgrade lands within this of its renewal date.
const TICK_MS = 10 * MINUTE_MS;
// A failed resize is tried again no sooner than this after it ended, so a provider at capacity is not asked every tick.
const RETRY_AFTER_MS = 30 * MINUTE_MS;
// A due downgrade waits for its machine to sleep, so nobody's session restarts under them, but not past this.
const AWAKE_GRACE_MS = 6 * 60 * MINUTE_MS;

const priceOf = (tier: string): number => (isHostedTierId(tier) ? hostedTier(tier).priceUsd : 0);

/** Resizes one sandbox's machine to its waiting plan, and clears the change once the machine is on it. Never throws. */
export const runPlanChange = async (prisma: PrismaClient, config: Config, logger: Logger, sandboxId: string): Promise<void> => {
    const machine = await prisma.hostedMachine.findUnique({
        where: { sandboxId },
        include: { sandbox: { select: { ownerId: true, token: true, owner: { select: { email: true } } } } },
    });
    const target = machine?.planTo ?? null;
    if (machine === null || target === null) {
        return;
    }
    const settled = { planTo: null, planAt: null, paid: isPaidTier(target) && machine.paid };
    if (target === machine.tier || !isHostedTierId(target)) {
        await prisma.hostedMachine.updateMany({ where: { sandboxId, planTo: target }, data: settled });
        return;
    }
    try {
        const migration = await migrateHosted(prisma, config, logger, machine, { tier: target }, machine.sandbox.owner.email.toLowerCase());
        if (migration.state === `done`) {
            // Only the change this run applied: one the owner replaced meanwhile is theirs to keep.
            await prisma.hostedMachine.updateMany({ where: { sandboxId, planTo: target }, data: settled });
            logger.info({ sandboxId, tier: target }, `hosted plan: sandbox is on its new plan`);
        }
    } catch (error) {
        logger.warn({ err: error, sandboxId, tier: target }, `hosted plan: resizing to the new plan did not finish; the plan-change job tries again`);
    }
};

/** Starts the resize without waiting for it: the request that paid for it answers in a second, the resize takes minutes. */
export const kickPlanChange = (prisma: PrismaClient, config: Config, logger: Logger, sandboxId: string): void => {
    void runPlanChange(prisma, config, logger, sandboxId);
};

/**
 * Every change that is due, one machine at a time: a downgrade once its machine sleeps (or has been awake past the
 * grace), an upgrade whose resize failed once the last attempt is old enough. Answers how many it tried.
 */
export const applyDuePlanChanges = async (prisma: PrismaClient, config: Config, logger: Logger, now: Date = new Date()): Promise<number> => {
    const due = await prisma.hostedMachine.findMany({
        where: { planTo: { not: null }, planAt: { lte: now }, migratingId: null },
        select: { sandboxId: true, tier: true, planTo: true, planAt: true, wokeAt: true },
    });
    let tried = 0;
    for (const machine of due) {
        const down = machine.planTo !== null && priceOf(machine.planTo) < priceOf(machine.tier);
        const pastGrace = machine.planAt !== null && now.getTime() - machine.planAt.getTime() >= AWAKE_GRACE_MS;
        if (down && machine.wokeAt !== null && !pastGrace) {
            continue;
        }
        // sequential, one machine at a time: a resize holds its machine for minutes and the provider rate-limits
        const last = await prisma.hostedMigration.findFirst({ where: { sandboxId: machine.sandboxId }, orderBy: { startedAt: `desc` }, select: { finishedAt: true } });
        const finishedAt = last?.finishedAt ?? null;
        if (finishedAt !== null && now.getTime() - finishedAt.getTime() < RETRY_AFTER_MS && machine.planTo !== machine.tier) {
            continue;
        }
        tried += 1;
        await runPlanChange(prisma, config, logger, machine.sandboxId);
    }
    return tried;
};

export const startHostedPlanChanges = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    if (!hostedEnabled(config)) {
        return;
    }
    const tick = async (): Promise<void> => {
        try {
            await runExclusive(config, JOB_HOSTED_PLAN, async () => {
                const tried = await applyDuePlanChanges(prisma, config, logger);
                if (tried > 0) {
                    logger.info({ tried }, `hosted plan: applied the plan changes that were due`);
                }
            });
        } catch (error) {
            logger.error({ err: error }, `hosted plan: the plan-change job failed`);
        }
    };
    void tick();
    setInterval(() => void tick(), TICK_MS);
};
