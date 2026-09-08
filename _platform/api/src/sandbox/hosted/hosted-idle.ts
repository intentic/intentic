import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { linkEmail, sendMail } from "../../mail.js";
import { onHostedPlan } from "./hosted-plan.js";
import { getMachine, isFlyGone, LIVE_STATES } from "./fly/fly.js";
import { destroyHosted, forgetHostedMachine, hostedEnabled } from "./hosted.js";
import { closeHostedStretch } from "./hosted-usage.js";
import { DAY_MS } from "../../durations.js";

// Destroys a hosted machine (disk and all) once its owner hasn't opened it in `hosted.idleDays`, with one warning at
// `hosted.idleWarnDays`; the sandbox row, name, address and sharing survive, so coming back means picking a new
// machine, not losing the workspace. Never:
// - a machine on the hosted plan
// - a machine Fly reports running (`lastSeenAt` is a boot announce, not a heartbeat)
// - a machine whose owner we couldn't ask about (Fly unreachable); retried tomorrow

// lastSeenAt is the daemon's last boot announcement; a machine that never announced is measured from its own creation,
// catching a stalled provision that was abandoned.
const idleSince = (machine: { createdAt: Date; sandbox: { lastSeenAt: Date | null } }): Date => machine.sandbox.lastSeenAt ?? machine.createdAt;

const warnMail = (config: Config, sandboxName: string, days: number) => ({
    subject: `Your intentic machine for "${sandboxName}" will be removed in ${days} days`,
    html: linkEmail({
        heading: `"${sandboxName}" has been sitting idle`,
        // States what goes, what stays, and the way to avoid this again; opening it is the real fix.
        body: `We run this sandbox's machine for free, and free machines are removed after a few weeks unopened. Open it and nothing happens, the timer resets. If you don't, in ${days} days the machine and the files on it are deleted. The sandbox itself, its name and its address all stay, so you can give it a new machine whenever you like. Running it on a computer of your own keeps everything indefinitely and has no limits at all.`,
        action: `Open the sandbox`,
        link: config.webOrigin,
    }),
    link: config.webOrigin,
});

// What one candidate turned out to be; `dropped` means the provider says the machine doesn't exist, not that it's idle.
type IdleVerdict = "kept" | "warned" | "destroyed" | "dropped";

interface IdleCandidate {
    readonly id: string;
    readonly appName: string;
    readonly machineId: string;
    readonly createdAt: Date;
    readonly idleWarnedAt: Date | null;
    // The open awake stretch, if any (hosted-usage.ts): closed before the row goes, or its minutes go with it.
    readonly wokeAt: Date | null;
    readonly sandbox: { id: string; name: string; lastSeenAt: Date | null; ownerId: string; owner: { email: string } };
}

// Decides one candidate: on the plan, gone, alive, past the axe, or owed its one warning. Split from the sweep loop so
// each stays one job.
const decideIdleMachine = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    machine: IdleCandidate,
    idleDaysSoFar: number,
): Promise<IdleVerdict> => {
    if (await onHostedPlan(prisma, config, machine.sandbox.ownerId)) {
        return `kept`;
    }
    // A row Fly no longer backs still holds the owner's one hosted slot, so leaving it blocks a replacement.
    const state = await getMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch((error: unknown) => {
        if (!isFlyGone(error)) {
            throw error;
        }
        return undefined;
    });
    if (state === undefined) {
        // A stretch still open on a machine that no longer exists ended at the latest now; charged before the
        // row that carries it is dropped, the same ceiling the meter's own settle takes for a gone machine.
        await closeHostedStretch(prisma, machine, machine.sandbox.ownerId);
        await forgetHostedMachine(prisma, machine.id, machine.sandbox.id);
        logger.warn({ app: machine.appName, sandboxId: machine.sandbox.id }, `hosted idle sweep: machine gone from the provider; row dropped`);
        return `dropped`;
    }
    if (LIVE_STATES.has(state.state)) {
        // Re-arms so a full warning period starts fresh whenever it does eventually stop.
        if (machine.idleWarnedAt !== null) {
            await prisma.hostedMachine.update({ where: { id: machine.id }, data: { idleWarnedAt: null } });
        }
        return `kept`;
    }
    if (idleDaysSoFar >= config.hosted.idleDays) {
        // Any stretch still open is closed at the stop Fly just reported, BEFORE the app goes: afterwards there
        // is no machine to ask and, a line later, no row to hold the minutes.
        await closeHostedStretch(prisma, machine, machine.sandbox.ownerId, state.updatedAt);
        await destroyHosted(config, machine.appName);
        // Row and address go with the machine; the sandbox stays, so its owner just picks a new one.
        await forgetHostedMachine(prisma, machine.id, machine.sandbox.id);
        logger.warn(
            { app: machine.appName, sandboxId: machine.sandbox.id, idleDays: Math.floor(idleDaysSoFar) },
            `hosted idle sweep: machine collected`,
        );
        return `destroyed`;
    }
    if (machine.idleWarnedAt !== null) {
        return `kept`;
    }
    // Mail first, stamp second: a stamp before a failed send would silently burn the one warning.
    await sendMail(config, logger, {
        to: machine.sandbox.owner.email,
        ...warnMail(config, machine.sandbox.name, Math.max(1, Math.ceil(config.hosted.idleDays - idleDaysSoFar))),
    });
    await prisma.hostedMachine.update({ where: { id: machine.id }, data: { idleWarnedAt: new Date() } });
    return `warned`;
};

// One pass, sequential (a platform has a handful of these, and it's gentler on Fly). One machine's failure is logged
// and retried tomorrow, never a partial teardown.
export const reapIdleHosted = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
): Promise<{ warned: number; destroyed: number; dropped: number }> => {
    const { idleDays, idleWarnDays } = config.hosted;
    if (!hostedEnabled(config) || idleDays === 0 || idleWarnDays === 0) {
        return { warned: 0, destroyed: 0, dropped: 0 };
    }
    const now = Date.now();
    const candidates = await prisma.hostedMachine.findMany({
        // The warn threshold is the wider net; everything past the destroy threshold falls inside it too.
        where: { sandbox: { OR: [{ lastSeenAt: { lt: new Date(now - idleWarnDays * DAY_MS) } }, { lastSeenAt: null }] } },
        select: {
            id: true,
            appName: true,
            machineId: true,
            createdAt: true,
            idleWarnedAt: true,
            wokeAt: true,
            sandbox: { select: { id: true, name: true, lastSeenAt: true, ownerId: true, owner: { select: { email: true } } } },
        },
    });
    const tally = { warned: 0, destroyed: 0, dropped: 0 };
    for (const machine of candidates) {
        const idleDaysSoFar = (now - idleSince(machine).getTime()) / DAY_MS;
        if (idleDaysSoFar < idleWarnDays) {
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
        const verdict = await decideIdleMachine(prisma, config, logger, machine, idleDaysSoFar).catch((error: unknown) => {
            logger.error({ err: error, app: machine.appName }, `hosted idle sweep: failed for this machine; retried tomorrow`);
            return `kept` as const;
        });
        if (verdict !== `kept`) {
            tally[verdict === `warned` ? `warned` : verdict === `destroyed` ? `destroyed` : `dropped`] += 1;
        }
    }
    return tally;
};
