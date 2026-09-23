import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { linkEmail, sendMail } from "../../mail.js";
import { onHostedPlan } from "./hosted-plan.js";
import { getMachine, isFlyGone, LIVE_STATES } from "./fly/fly.js";
import { destroyHosted, forgetHostedMachine, hostedEnabled } from "./hosted.js";
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
    // The sandbox whose month any open stretch lands on; the meter is per machine (hosted-usage.ts).
    readonly sandboxId: string;
    readonly appName: string;
    readonly machineId: string;
    readonly createdAt: Date;
    readonly idleWarnedAt: Date | null;
    readonly sandbox: { id: string; name: string; lastSeenAt: Date | null; ownerId: string; owner: { email: string } };
}

/* THE WARNING IS A PROMISE, NOT A FORMALITY, and the clock alone used to be enough to break it. Collection was
 * reached on `idleDaysSoFar >= idleDays` and nothing else, so any machine already past the deadline the first
 * time the sweep considered it was destroyed with no mail ever sent. That is not a corner case: it is exactly
 * what LOWERING idleDays does to every machine sitting between the old threshold and the new one, and a fleet
 * is tightened precisely when it is full of forgotten disks. The same hole opens whenever the sweep has been
 * off, failing, or pointed at a fleet older than itself.
 *
 * So the deadline is necessary and no longer sufficient: a machine is collected once a notice has STOOD for
 * the notice period, however far past the deadline it already is. The worst a tightened threshold can now do
 * is warn everybody today and collect them a notice period from today. */
// What the mail may truthfully promise: the later of the deadline and the notice period this mail itself starts,
// since a machine already past the deadline is held for the whole notice regardless.
const daysOfGrace = (config: Config, idleDaysSoFar: number): number =>
    Math.max(1, Math.ceil(Math.max(config.hosted.idleDays - idleDaysSoFar, config.hosted.idleDays - config.hosted.idleWarnDays)));

const noticeServed = (config: Config, machine: IdleCandidate, now: number): boolean =>
    machine.idleWarnedAt !== null &&
    now - machine.idleWarnedAt.getTime() >= Math.max(0, config.hosted.idleDays - config.hosted.idleWarnDays) * DAY_MS;

// Decides one candidate: on the plan, gone, alive, past the axe with notice served, or owed its one warning. Split
// from the sweep loop so each stays one job.
const decideIdleMachine = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    machine: IdleCandidate,
    idleDaysSoFar: number,
    now: number,
): Promise<IdleVerdict> => {
    if (await onHostedPlan(prisma, config, machine.sandbox.ownerId)) {
        return `kept`;
    }
    const row = { id: machine.id, sandboxId: machine.sandboxId, ownerId: machine.sandbox.ownerId };
    // A row Fly no longer backs still holds the owner's one hosted slot, so leaving it blocks a replacement.
    const state = await getMachine(config.hosted.flyApiToken, machine.appName, machine.machineId).catch((error: unknown) => {
        if (!isFlyGone(error)) {
            throw error;
        }
        return undefined;
    });
    if (state === undefined) {
        // A stretch still open on a machine that no longer exists is charged up to now, as the meter's settle does.
        await forgetHostedMachine(prisma, row);
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
    if (idleDaysSoFar >= config.hosted.idleDays && noticeServed(config, machine, now)) {
        await destroyHosted(config, machine.appName);
        // Row and address go with the machine; the sandbox stays, so its owner just picks a new one.
        await forgetHostedMachine(prisma, row, state.updatedAt);
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
        ...warnMail(config, machine.sandbox.name, daysOfGrace(config, idleDaysSoFar)),
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
            sandboxId: true,
            appName: true,
            machineId: true,
            createdAt: true,
            idleWarnedAt: true,
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
        const verdict = await decideIdleMachine(prisma, config, logger, machine, idleDaysSoFar, now).catch((error: unknown) => {
            logger.error({ err: error, app: machine.appName }, `hosted idle sweep: failed for this machine; retried tomorrow`);
            return `kept` as const;
        });
        if (verdict !== `kept`) {
            tally[verdict === `warned` ? `warned` : verdict === `destroyed` ? `destroyed` : `dropped`] += 1;
        }
    }
    return tally;
};
