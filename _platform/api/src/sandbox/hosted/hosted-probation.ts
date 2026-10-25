import { hostedTier } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import { judgeProbation, type ProbationLook, probationStep, UPDATE_PROBATION } from "@intentic/sandbox-contract/state/update-probation";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { decryptSecret } from "../../crypto.js";
import { MINUTE_MS } from "../../durations.js";
import { JOB_HOSTED_PROBATION, runExclusive } from "../../jobs-lock.js";
import { askCrashLoopRestarts, askHealth, type DaemonHealthAnswer, READY_BUDGET_MS } from "./gate/daemon-health.js";
import { PROBATION_ENDS } from "./gate/gate-row.js";
import { HostedImageKept, HostedMachineBusy } from "./gate/state-gate.js";
import { getMachineDetail, stopMachine } from "./fly/fly.js";
import { withHostedAppLock } from "./hosted-app-lock.js";
import { HostedNothingKept, hostedEnabled, rollbackHosted } from "./hosted.js";
import { hostedBudgetOf, openHostedStretch, settleHostedStretch } from "./hosted-usage.js";

/* Watch gate-stamped images with previousImage and no unprovenImage using the shared UPDATE_PROBATION policy for one day.
 * After three failed looks or an unrecoverable journal/daemon failure, rollbackHosted restores the prior image and skips the failed digest.
 * Skip asleep/booting/busy machines, uncertain Fly reads and changed rows; take the app lock without waiting. Doubt is not a strike.
 * Process machines serially; log rollback outcomes without mailing. A failed rollback ends probation rather than retrying. */

// How often a machine on probation is looked at. ic's agent looks once a minute; Fly's exec is a heavier question than a
// `docker exec`, and three strikes in a row at this pace are about six minutes of an image that is plainly down.
export const PROBATION_LOOK_MS = 2 * MINUTE_MS;

// A started machine younger than this is a boot (a wake, the owner's visit), whatever its daemon answers yet.
const BOOTING_MS = READY_BUDGET_MS;

// What the sweep reads of a machine on probation: the row's own columns, and the sandbox it carries the grant of.
export interface ProbationCandidate {
    readonly id: string;
    readonly sandboxId: string;
    readonly appName: string;
    readonly machineId: string;
    readonly volumeId: string;
    readonly region: string;
    readonly tier: string;
    readonly cpuKind: string;
    readonly cpus: number;
    readonly memoryMb: number;
    readonly volumeGb: number;
    readonly wokeAt: Date | null;
    readonly image: string | null;
    readonly baseDigest: string | null;
    readonly environmentHash: string | null;
    readonly previousImage: string | null;
    readonly previousEnvironmentHash: string | null;
    readonly unprovenImage: string | null;
    readonly probationSince: Date | null;
    readonly probationStrikes: number;
    readonly sandbox: { readonly token: string; readonly ownerId: string; readonly owner: { readonly email: string } };
}

// What one machine's turn came to, for the log and the tests.
export type ProbationOutcome =
    | { readonly kind: "watching"; readonly strikes: number; readonly reason?: string }
    | { readonly kind: "kept" }
    | { readonly kind: "ended"; readonly why: string }
    | { readonly kind: "rolled-back"; readonly reason: string }
    | { readonly kind: "skipped"; readonly why: string };

const skipped = (why: string): ProbationOutcome => ({ kind: "skipped", why });

// Fly's states a machine passes through; none of them is a verdict on the daemon in it.
const STARTED = `started`;

/* ONE LOOK, as the contract's `ProbationLook`, or the reason there is nothing to judge yet. A machine that is not started is
 * "stopped on purpose" to the rule (`held`): it is Pending until it runs. Read inside the app's lock, so a gate's probe
 * (a sleep in place of the daemon) can never be read as a daemon that does not answer. */
const lookAt = async (config: Config, machine: ProbationCandidate, now: number): Promise<{ readonly look: ProbationLook } | { readonly skip: string }> => {
    // allow(silent-catch): Fly not answering is doubt, and doubt is never a strike; the same machine is looked at next tick
    const detail = await getMachineDetail(config.hosted.flyApiToken, machine.appName, machine.machineId).catch(() => undefined);
    if (detail === undefined) {
        return { skip: `Fly would not describe the machine` };
    }
    const quiet: ProbationLook = {
        running: false,
        restarting: false,
        restarts: 0,
        answered: false,
        ready: null,
        journal: null,
        reach: null,
        bootFailure: null,
        daemonRestarts: 0,
        crashLoop: null,
        held: true,
    };
    if (detail.state !== STARTED) {
        return { look: quiet };
    }
    if (detail.updatedAt !== undefined && now - detail.updatedAt.getTime() < BOOTING_MS) {
        return { skip: `the machine started less than ${READY_BUDGET_MS / MINUTE_MS} minutes ago` };
    }
    const answer: DaemonHealthAnswer | undefined = await askHealth(config, machine);
    const looping = answer === undefined ? await askCrashLoopRestarts(config, machine) : undefined;
    return {
        look: {
            ...quiet,
            running: true,
            held: false,
            answered: answer !== undefined,
            ready: answer?.ready ?? null,
            journal: answer === undefined ? null : answer.journal === `closed` ? `none` : answer.journal,
            // The words ic's own health.rs `crash_loop` says, so one reason reads the same on either substrate.
            crashLoop: looping === undefined ? null : `netd restarted it ${looping} times in the last ten minutes, and it is down again`,
        },
    };
};

// The row as it stands now, for a decision made on a look taken a moment ago.
const reread = async (prisma: PrismaClient, id: string): Promise<{ probationSince: Date | null; previousImage: string | null; unprovenImage: string | null } | null> =>
    prisma.hostedMachine.findUnique({ where: { id }, select: { probationSince: true, previousImage: true, unprovenImage: true } });

const endProbation = async (prisma: PrismaClient, id: string): Promise<void> => {
    await prisma.hostedMachine.update({ where: { id }, data: PROBATION_ENDS });
};

/* PUTS THE PREVIOUS IMAGE BACK, the way the owner's press does (sandbox.routes.ts hostedRollback): the machine stopped
 * under the app's lock, its stretch settled, then the gate's rollback, then a stretch opened for the start it ended in. */
const goBack = async (prisma: PrismaClient, config: Config, logger: Logger, machine: ProbationCandidate, reason: string): Promise<ProbationOutcome> => {
    const now = await reread(prisma, machine.id);
    if (now === null || now.probationSince?.getTime() !== machine.probationSince?.getTime() || now.previousImage !== machine.previousImage || now.unprovenImage !== null) {
        return skipped(`the row changed under the look`);
    }
    const ownerId = machine.sandbox.ownerId;
    const budget = await hostedBudgetOf(prisma, config, { sandboxId: machine.sandboxId, ownerId });
    if (budget.metered && budget.remainingMinutes === 0) {
        // Starting it would spend hours its owner no longer has; the meter stops it again at its next tick.
        return skipped(`its owner's hours are spent`);
    }
    const stopped = await withHostedAppLock(config, machine.appName, false, async () => {
        await stopMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch((error) =>
            logger.warn({ err: error, app: machine.appName }, `hosted probation: stop refused; going back anyway`),
        );
        // Not `undefined`: that is what the lock answers when another change holds the machine.
        return true;
    });
    if (stopped === undefined) {
        return skipped(`another change holds the machine`);
    }
    await settleHostedStretch(prisma, config, logger, { ...machine, ownerId });
    try {
        await rollbackHosted(
            config,
            { sandboxId: machine.sandboxId, connectToken: decryptSecret(config, machine.sandbox.token), ownerEmail: machine.sandbox.owner.email, region: machine.region, tier: hostedTier(machine.tier).id },
            machine,
            logger,
            { prisma, hostedMachineId: machine.id, sandboxId: machine.sandboxId },
            { probation: false, busy: `refuse` },
        );
    } catch (error) {
        if (error instanceof HostedMachineBusy) {
            return skipped(`another change holds the machine`);
        }
        // The gate has put back what it could (HostedImageKept), or there is nothing to go back to: either way a second
        // attempt in two minutes would stop and start the machine again for the same answer.
        const nothing = error instanceof HostedNothingKept;
        const kept = error instanceof HostedImageKept;
        logger[nothing || kept ? `warn` : `error`](
            { err: error, app: machine.appName, previousImage: machine.previousImage },
            `hosted probation: going back from the new image failed (${reason}); the probation ends`,
        );
        await endProbation(prisma, machine.id);
        return { kind: `ended`, why: `going back failed` };
    }
    if (!(await openHostedStretch(prisma, { id: machine.id, sandboxId: machine.sandboxId, ownerId }))) {
        // A row gone mid-start (trash, release, the idle sweep) has nothing to bill the run.
        await stopMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch((error) =>
            logger.error({ err: error, app: machine.appName }, `hosted probation: a machine started after its row was deleted could not be stopped`),
        );
    }
    logger.warn({ app: machine.appName, previousImage: machine.previousImage, reason }, `hosted probation: the new image kept failing, so the earlier one was put back`);
    return { kind: `rolled-back`, reason };
};

/* ONE MACHINE'S TURN: look, judge by the contract's rule, and act on the step. `now` is the clock, a parameter so a suite
 * plays a day in a moment. */
export const watchHostedMachine = async (prisma: PrismaClient, config: Config, logger: Logger, machine: ProbationCandidate, now: number): Promise<ProbationOutcome> => {
    const since = machine.probationSince;
    if (since === null) {
        return skipped(`the row names no probation`);
    }
    if (machine.previousImage === null) {
        // Nothing kept to go back to (a rollback the owner pressed twice, an image put back by the gate): nothing to watch for.
        await endProbation(prisma, machine.id);
        return { kind: `ended`, why: `no earlier image is kept` };
    }
    if (machine.unprovenImage !== null) {
        return skipped(`the image is on trial; its next start judges it`);
    }
    const over = now >= since.getTime() + UPDATE_PROBATION.watchMs;
    const read = await withHostedAppLock(config, machine.appName, false, () => lookAt(config, machine, now));
    if (read === undefined) {
        return skipped(`another change holds the machine`);
    }
    if (`skip` in read) {
        return skipped(read.skip);
    }
    const verdict = judgeProbation(read.look, { at: since.getTime(), reach: null }, now);
    const step = probationStep(verdict, machine.probationStrikes, over);
    switch (step.action) {
        case `roll-back`:
            return goBack(prisma, config, logger, machine, step.reason);
        case `keep`:
            await endProbation(prisma, machine.id);
            return { kind: `kept` };
        case `watch`: {
            if (step.strikes !== machine.probationStrikes) {
                await prisma.hostedMachine.update({ where: { id: machine.id }, data: { probationStrikes: step.strikes } });
            }
            return step.reason === undefined ? { kind: `watching`, strikes: step.strikes } : { kind: `watching`, strikes: step.strikes, reason: step.reason };
        }
    }
};

const SELECTED = {
    id: true,
    sandboxId: true,
    appName: true,
    machineId: true,
    volumeId: true,
    region: true,
    tier: true,
    cpuKind: true,
    cpus: true,
    memoryMb: true,
    volumeGb: true,
    wokeAt: true,
    image: true,
    baseDigest: true,
    environmentHash: true,
    previousImage: true,
    previousEnvironmentHash: true,
    unprovenImage: true,
    probationSince: true,
    probationStrikes: true,
    sandbox: { select: { token: true, ownerId: true, owner: { select: { email: true } } } },
} as const;

export interface ProbationSweep {
    readonly looked: number;
    readonly rolledBack: number;
    readonly kept: number;
}

// Every machine on probation, one at a time: Fly's exec is the heavy call, and the fleet is not in a hurry.
export const sweepHostedProbation = async (prisma: PrismaClient, config: Config, logger: Logger, now: number = Date.now()): Promise<ProbationSweep> => {
    const machines = await prisma.hostedMachine.findMany({ where: { probationSince: { not: null } }, select: SELECTED });
    let rolledBack = 0;
    let kept = 0;
    for (const machine of machines) {
        // sequential sweep, gentle on Fly
        const outcome = await watchHostedMachine(prisma, config, logger, machine, now).catch((error): ProbationOutcome => {
            logger.error({ err: error, app: machine.appName }, `hosted probation: looking at the machine failed; looked at again next tick`);
            return skipped(`the look failed`);
        });
        rolledBack += outcome.kind === `rolled-back` ? 1 : 0;
        kept += outcome.kind === `kept` ? 1 : 0;
        if (outcome.kind === `watching` && outcome.reason !== undefined) {
            logger.warn({ app: machine.appName, strikes: outcome.strikes, reason: outcome.reason }, `hosted probation: the new image failed a look`);
        }
    }
    return { looked: machines.length, rolledBack, kept };
};

// Boot wiring (main.ts): every PROBATION_LOOK_MS, one replica at a time (two would count one failure twice).
export const startHostedProbation = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    if (!hostedEnabled(config)) {
        return;
    }
    const tick = (): void => {
        void runExclusive(config, JOB_HOSTED_PROBATION, async () => {
            await sweepHostedProbation(prisma, config, logger);
        }).catch((error) => logger.error({ err: error }, `hosted probation sweep failed`));
    };
    tick();
    setInterval(tick, PROBATION_LOOK_MS);
};
