import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { JOB_HOSTED_METER, JOB_HOSTED_MIGRATE, runExclusive } from "../../jobs-lock.js";
import { getMachine, isFlyGone, LIVE_STATES, stopMachine } from "./fly/fly.js";
import { withHostedAppLock } from "./hosted-app-lock.js";
import { hostedEnabled } from "./hosted.js";
import { type AccountHours, accountHoursOf, settleHostedStretches } from "./hosted-usage.js";
import { sweepHostedMigrations } from "./migrate/hosted-migrate.js";

// Hourly: settles the stretch of every machine that stopped since last look, then stops a machine once the hours it
// spends are gone past `hosted.overBudgetGraceMinutes`, and a suspended owner's whatever the hours say. Backstops the
// daemon's in-box idle-stop (tmux activity keeps a machine awake, and an awake machine is never settled or charged) and
// a suspension whose stop Fly refused. A machine whose hours count against no ceiling (a comped account's) is never
// stopped for them.

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

/* THE TICK NEVER STOPS A MACHINE IN THE MIDDLE OF A CHANGE. An image change holds the app's lock from its probe to its
 * new daemon's verdict (gate/state-gate.ts), and a stop in there would leave that version unjudged; a move or a cleanup
 * holds it too. So the tick's stop takes the lock without waiting, and a machine mid-change is left to the next tick,
 * which asks again, a suspended owner's included. */
const stopUnlessChanging = async (config: Config, logger: Logger, machine: OpenMachine, why: string): Promise<boolean> => {
    const stopped = await withHostedAppLock(config, machine.appName, false, () => stopIfRunning(config, logger, machine, why));
    if (stopped === undefined) {
        logger.info({ app: machine.appName, ownerId: machine.sandbox.ownerId }, `hosted meter: the machine is being changed; stopping it waits for the next tick`);
        return false;
    }
    return stopped;
};

// One owner's machines, for one stated reason. Sequential and best-effort: one failure must not cost the rest. Also
// the stop behind a suspension (hosted-standing.ts), which waits neither for this tick nor for a change in flight: a
// suspension holds at once, and a gate waiting on its new daemon reads a stop it was not asked for as the version
// interrupted, left on trial, never as one to put back and start.
export const stopOwnerMachines = async (
    config: Config,
    logger: Logger,
    machines: readonly OpenMachine[],
    why: string,
    stop: typeof stopIfRunning = stopIfRunning,
): Promise<number> => {
    let stopped = 0;
    for (const machine of machines) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
        const did = await stop(config, logger, machine, why).catch((error: unknown) => {
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
// hours say, and costs no meter read), then the hours this machine spends, gone past their grace.
const stopReason = async (
    prisma: PrismaClient,
    config: Config,
    machine: { sandboxId: string; ownerId: string },
    hoursOf: (ownerId: string) => Promise<AccountHours>,
): Promise<string | undefined> => {
    const owner = await prisma.user.findUnique({ where: { id: machine.ownerId }, select: { hostedSuspendedAt: true } });
    if (owner?.hostedSuspendedAt) {
        return `its owner's hosted lane is suspended`;
    }
    const hours = await hoursOf(machine.ownerId);
    const budget = hours.machines.get(machine.sandboxId) ?? hours.free;
    if (!budget.metered || budget.usedMinutes < budget.allowanceMinutes + config.hosted.overBudgetGraceMinutes) {
        return undefined;
    }
    return budget.kind === `free` ? `its account's free hours for the month are spent` : `this machine's hours on its slot are spent for the month`;
};

// One pass over every open-stretch machine, judged one at a time against the hours it spends: an account holding a
// free machine that spent the free hours and a paid one nowhere near its own must lose only the first. Each account's
// hours are read once per pass, since two free machines of one account spend the same hours.
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
        select: { id: true, sandboxId: true, appName: true, machineId: true, sandbox: { select: { ownerId: true } } },
    });
    const read = new Map<string, Promise<AccountHours>>();
    const hoursOf = (ownerId: string): Promise<AccountHours> => {
        const known = read.get(ownerId);
        if (known !== undefined) {
            return known;
        }
        const fresh = accountHoursOf(prisma, config, ownerId, now);
        read.set(ownerId, fresh);
        return fresh;
    };
    let stopped = 0;
    for (const machine of open) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
        const why = await stopReason(prisma, config, { sandboxId: machine.sandboxId, ownerId: machine.sandbox.ownerId }, hoursOf);
        if (why !== undefined) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
            stopped += await stopOwnerMachines(config, logger, [machine], why, stopUnlessChanging);
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
