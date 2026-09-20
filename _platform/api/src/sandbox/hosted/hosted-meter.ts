import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { JOB_HOSTED_METER, JOB_HOSTED_MIGRATE, runExclusive } from "../../jobs-lock.js";
import { getMachine, isFlyGone, LIVE_STATES, stopMachine } from "./fly/fly.js";
import { hostedEnabled } from "./hosted.js";
import { hostedBudgetOf, settleHostedStretches } from "./hosted-usage.js";
import { sweepHostedMigrations } from "./migrate/hosted-migrate.js";

// Hourly: settles the stretch of every machine that stopped since last look, then stops a metered owner's machines once
// their month is spent past `hosted.overBudgetGraceMinutes`, and a suspended owner's whatever the month says. Backstops
// the daemon's in-box idle-stop (tmux activity keeps a free machine awake, and an awake machine is never settled or
// charged) and a suspension whose stop Fly refused. A subscriber in good standing is never touched.

const TICK_MS = 60 * 60 * 1000;

interface OpenMachine {
    readonly id: string;
    readonly appName: string;
    readonly machineId: string;
    readonly sandbox: { readonly ownerId: string };
}

// Asks Fly first: an open `wokeAt` also describes a machine that already stopped on its own before the settle above
// closed it, and stopping a stopped machine is noise.
const stopIfRunning = async (config: Config, logger: Logger, machine: OpenMachine, why: string): Promise<boolean> => {
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
    logger.warn({ app: machine.appName, ownerId: machine.sandbox.ownerId }, `hosted meter: machine stopped, ${why}`);
    return true;
};

// One owner's machines, for one stated reason. Sequential and best-effort: one failure must not cost the rest. Also
// the stop behind a suspension (hosted-standing.ts), which must not wait for this tick.
export const stopOwnerMachines = async (config: Config, logger: Logger, machines: readonly OpenMachine[], why: string): Promise<number> => {
    let stopped = 0;
    for (const machine of machines) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
        const did = await stopIfRunning(config, logger, machine, why).catch((error: unknown) => {
            logger.error({ err: error, app: machine.appName }, `hosted meter: stopping failed; retried next tick`);
            return false;
        });
        if (did) {
            stopped += 1;
        }
    }
    return stopped;
};

// Why one owner's awake machines must stop now, or undefined to leave them: a suspension first (it holds whatever the
// month says, and costs no meter read), then the month spent past its grace.
const stopReason = async (
    prisma: PrismaClient,
    config: Config,
    machine: { sandboxId: string; tier: string; ownerId: string },
    now: Date,
): Promise<string | undefined> => {
    const owner = await prisma.user.findUnique({ where: { id: machine.ownerId }, select: { hostedSuspendedAt: true } });
    if (owner?.hostedSuspendedAt) {
        return `its owner's hosted lane is suspended`;
    }
    const budget = await hostedBudgetOf(prisma, config, machine, now);
    return budget.metered && budget.usedMinutes >= budget.allowanceMinutes + config.hosted.overBudgetGraceMinutes
        ? `this machine's hours for the month are spent`
        : undefined;
};

// One pass over every open-stretch machine, judged one at a time: the ceiling belongs to the machine's rung, so an
// account holding a spent free machine and a paid one that is nowhere near its hours must lose only the first.
export const stopOverBudgetHosted = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    now: Date = new Date(),
): Promise<{ stopped: number }> => {
    if (!hostedEnabled(config)) {
        return { stopped: 0 };
    }
    const open = await prisma.hostedMachine.findMany({
        where: { wokeAt: { not: null } },
        select: { id: true, sandboxId: true, tier: true, appName: true, machineId: true, sandbox: { select: { ownerId: true } } },
    });
    let stopped = 0;
    for (const machine of open) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
        const why = await stopReason(prisma, config, { sandboxId: machine.sandboxId, tier: machine.tier, ownerId: machine.sandbox.ownerId }, now);
        if (why !== undefined) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
            stopped += await stopOwnerMachines(config, logger, [machine], why);
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
                logger.warn({ stopped }, `hosted meter: tick stopped machines over their owners' month or standing`);
            }
        }).catch((error: unknown) => logger.error({ err: error }, `hosted meter tick failed`));
        // Rides the same hour, under its own lock: a dead migration holds a machine locked and may be paying for a
        // half-built second one, and neither frees itself.
        void runExclusive(config, JOB_HOSTED_MIGRATE, async () => {
            await sweepHostedMigrations(prisma, config, logger);
        }).catch((error: unknown) => logger.error({ err: error }, `hosted migrate sweep failed`));
    };
    tick();
    setInterval(tick, TICK_MS);
};
