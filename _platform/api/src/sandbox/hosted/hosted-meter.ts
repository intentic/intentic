import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { JOB_HOSTED_METER, runExclusive } from "../../jobs-lock.js";
import { getMachine, isFlyGone, LIVE_STATES, stopMachine } from "./fly/fly.js";
import { hostedEnabled } from "./hosted.js";
import { hostedBudgetOf, settleHostedStretches } from "./hosted-usage.js";

// Hourly: settles the stretch of every machine that stopped since last look, then stops a metered owner's machines once
// their month is spent past `hosted.overBudgetGraceMinutes`. Backstops the daemon's in-box idle-stop (tmux activity
// keeps a free machine awake, and an awake machine is never settled or charged). A subscriber is never touched.

const TICK_MS = 60 * 60 * 1000;

interface OpenMachine {
    readonly id: string;
    readonly appName: string;
    readonly machineId: string;
    readonly sandbox: { readonly ownerId: string };
}

// Asks Fly first: an open `wokeAt` also describes a machine that already stopped on its own before the settle above
// closed it, and stopping a stopped machine is noise.
const stopIfRunning = async (config: Config, logger: Logger, machine: OpenMachine): Promise<boolean> => {
    const state = await getMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch((error: unknown) => {
        if (isFlyGone(error)) {
            return undefined;
        }
        throw error;
    });
    if (state === undefined || !LIVE_STATES.has(state.state)) {
        return false;
    }
    await stopMachine(config.hosted.flyApiToken, machine.appName, machine.machineId);
    logger.warn({ app: machine.appName, ownerId: machine.sandbox.ownerId }, `hosted meter: machine stopped, its owner's free hours are spent`);
    return true;
};

// One owner's machines, once their month is spent. Sequential and best-effort: one failure must not cost the rest.
const stopOwnerMachines = async (config: Config, logger: Logger, machines: readonly OpenMachine[]): Promise<number> => {
    let stopped = 0;
    for (const machine of machines) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
        const did = await stopIfRunning(config, logger, machine).catch((error: unknown) => {
            logger.error({ err: error, app: machine.appName }, `hosted meter: stopping failed; retried next tick`);
            return false;
        });
        if (did) {
            stopped += 1;
        }
    }
    return stopped;
};

// One pass over every open-stretch machine, grouped by owner so the budget is read once and several machines stop
// together, not one an hour.
export const stopOverBudgetHosted = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    now: Date = new Date(),
): Promise<{ stopped: number }> => {
    if (!hostedEnabled(config) || config.hosted.monthlyHours === 0) {
        return { stopped: 0 };
    }
    const open = await prisma.hostedMachine.findMany({
        where: { wokeAt: { not: null } },
        select: { id: true, appName: true, machineId: true, sandbox: { select: { ownerId: true } } },
    });
    const byOwner = new Map<string, OpenMachine[]>();
    for (const machine of open) {
        byOwner.set(machine.sandbox.ownerId, [...(byOwner.get(machine.sandbox.ownerId) ?? []), machine]);
    }
    let stopped = 0;
    for (const [ownerId, machines] of byOwner) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
        const budget = await hostedBudgetOf(prisma, config, ownerId, now);
        if (budget.metered && budget.usedMinutes >= budget.allowanceMinutes + config.hosted.overBudgetGraceMinutes) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
            stopped += await stopOwnerMachines(config, logger, machines);
        }
    }
    return { stopped };
};

export const startHostedMeter = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    if (!hostedEnabled(config)) {
        return;
    }
    const tick = (): void => {
        void runExclusive(config, JOB_HOSTED_METER, async () => {
            // Settle first: a self-stopped machine's minutes land on the books before any budget is read.
            await settleHostedStretches(prisma, config, logger);
            const { stopped } = await stopOverBudgetHosted(prisma, config, logger);
            if (stopped > 0) {
                logger.warn({ stopped }, `hosted meter: tick stopped machines over their owners' month`);
            }
        }).catch((error: unknown) => logger.error({ err: error }, `hosted meter tick failed`));
    };
    tick();
    setInterval(tick, TICK_MS);
};
