import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { JOB_HOSTED_METER, runExclusive } from "../../jobs-lock.js";
import { getMachine, isFlyGone, stopMachine } from "./fly.js";
import { hostedEnabled } from "./hosted.js";
import { hostedBudgetOf, LIVE_STATES, settleHostedStretches } from "./hosted-usage.js";

/* THE HOUR METER'S TICK, hourly: settle the stretch of every machine that has stopped since anyone looked, and
 * stop the machines of a metered owner whose month is spent.
 *
 * The second half is the one this file exists for. The ceiling used to be enforced at wake and nowhere else,
 * on the principle that a box is never killed under someone's hands to sell them a plan. The principle
 * stands; the gap it left did not survive contact with how a machine stops. Stopping is the daemon's idle-stop,
 * decided inside the box by five probes, one of them tmux activity, and the owner is root in there: a pane
 * printing a line a minute keeps a free machine awake, an awake machine is never settled, and a machine never
 * settled was never charged. Forty free hours meant forty hours of stopping. This tick is the platform's side
 * of the number: it counts the open stretch live (hostedUsedMinutes) and, once the month is spent by more than
 * `hosted.overBudgetGraceMinutes`, stops the machine through Fly. The next wake then refuses with
 * PAYMENT_REQUIRED, and the editor's gate finally gets to say why.
 *
 * WHY A GRACE HOUR AND NOT ZERO: the editor's meter reads the same live figure, its strip warns at the last
 * hours, and the gate that refuses the wake says what happened. Stopping exactly at the ceiling would still be
 * a stop under someone's hands the minute after the meter hit zero; an hour past it, on a machine whose meter
 * has read zero for an hour, is the version of this that nobody can call a surprise. A subscriber is never
 * touched: `hostedBudgetOf` answers unmetered before any machine is read. */

const TICK_MS = 60 * 60 * 1000;

interface OpenMachine {
    readonly id: string;
    readonly appName: string;
    readonly machineId: string;
    readonly sandbox: { readonly ownerId: string };
}

// The stop, for one machine: asked of Fly first, because an open `wokeAt` is also what a machine that stopped
// on its own looks like until the settle above closes it, and stopping a stopped machine is noise.
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

// One owner's machines, once their month is known to be spent. Sequential and best-effort, the sweeps'
// shared shape: a handful of machines, and one failure must not cost the rest.
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

/* One pass over every machine with an open stretch, grouped by owner so the budget is read once per owner and
 * a person with several machines sees them all stop together rather than one an hour. */
export const stopOverBudgetHosted = async (prisma: PrismaClient, config: Config, logger: Logger, now: Date = new Date()): Promise<{ stopped: number }> => {
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
            // Settle first: a machine that stopped on its own since the last tick has its minutes on the
            // books before anybody's budget is read, and is not a candidate for a stop it no longer needs.
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
