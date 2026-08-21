import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { linkEmail, sendMail } from "../../mail.js";
import { premiumOf } from "../../pool/pool-membership.js";
import { getMachine } from "./fly.js";
import { destroyHosted, hostedEnabled } from "./hosted.js";

/* COLLECTING THE MACHINES NOBODY CAME BACK TO, the free hosted lane's largest cost and its least useful one.
 *
 * A hosted disk bills every day it exists, awake or asleep, and until this the only thing that ever removed
 * one was a user deleting their sandbox. So a machine someone tried once in spring was still costing money in
 * autumn, and the bill grew with signups forever rather than with use. This sweep is the answer: a machine
 * whose owner has no membership and which nobody has opened for `hosted.idleDays` is destroyed, disk and all,
 * one warning email earlier at `hosted.idleWarnDays`.
 *
 * WHAT IS DELETED IS THE MACHINE, NOT THE SANDBOX. The row, the name, the address and the sharing all survive,
 * so coming back after a month means picking a machine again, the wizard's ordinary first screen, rather
 * than finding the workspace itself gone. That is also why the warning is worth sending: the remedy is one
 * click, and it is only free-lane data that was never backed up in the first place (the lane's card says so
 * before anybody chooses it).
 *
 * THREE THINGS IT REFUSES TO TAKE, each because taking it would be a bug rather than a saving:
 *   - a member's machine, ever. Membership is the thing being sold; it is not an alarm clock.
 *   - a machine that is RUNNING right now. `lastSeenAt` is stamped by the daemon's boot announce, so a box
 *     that has been up for a month, a long-lived dev server, a job nobody restarted, reads as untouched
 *     while being exactly the opposite. Fly is asked before anything is destroyed, and a live machine is left
 *     alone and re-armed.
 *   - a machine whose owner we could not ask about, because Fly was unreachable. Tomorrow's sweep retries;
 *     a provider we cannot reach is not evidence of anything. */

const DAY_MS = 24 * 60 * 60 * 1000;

// The states in which a machine is alive and must not be collected. Same set the meter and the wake path use.
const LIVE_STATES = new Set([`created`, `starting`, `started`, `replacing`]);

// How long a machine has gone unopened. `lastSeenAt` is the daemon's last boot announce; a machine that has
// never announced at all is measured from its own creation, which is what catches a provision that failed to
// come up and was then abandoned, the exact case that leaves a disk billing for nothing.
const idleSince = (machine: { createdAt: Date; sandbox: { lastSeenAt: Date | null } }): Date => machine.sandbox.lastSeenAt ?? machine.createdAt;

const warnMail = (config: Config, sandboxName: string, days: number) => ({
    subject: `Your intentic machine for "${sandboxName}" will be removed in ${days} days`,
    html: linkEmail({
        heading: `"${sandboxName}" has been sitting idle`,
        // Says the whole thing: what goes, what stays, what stops it, and the one alternative that makes the
        // question never come up again. No urgency theatre, the remedy really is to open it.
        body: `We run this sandbox's machine for free, and free machines are removed after a few weeks unopened. Open it and nothing happens, the timer resets. If you don't, in ${days} days the machine and the files on it are deleted. The sandbox itself, its name and its address all stay, so you can give it a new machine whenever you like. Running it on a computer of your own, or on your own cloud account, keeps everything indefinitely and has no limits at all.`,
        action: `Open the sandbox`,
        link: config.webOrigin,
    }),
    link: config.webOrigin,
});

/* One pass. Sequential on purpose, a platform has a handful of these at most, the Fly API is happier for it,
 * and one machine's failure must not cost the rest of the sweep. Every failure is logged and retried tomorrow;
 * nothing here is urgent enough to be worth a partial teardown. */
export const reapIdleHosted = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<{ warned: number; destroyed: number }> => {
    const { idleDays, idleWarnDays } = config.hosted;
    if (!hostedEnabled(config) || idleDays === 0 || idleWarnDays === 0) {
        return { warned: 0, destroyed: 0 };
    }
    const now = Date.now();
    const candidates = await prisma.hostedMachine.findMany({
        // The warn threshold is the wider net; everything past the destroy threshold is inside it.
        where: { sandbox: { OR: [{ lastSeenAt: { lt: new Date(now - idleWarnDays * DAY_MS) } }, { lastSeenAt: null }] } },
        select: {
            id: true,
            appName: true,
            machineId: true,
            createdAt: true,
            idleWarnedAt: true,
            sandbox: { select: { id: true, name: true, lastSeenAt: true, ownerId: true, owner: { select: { email: true } } } },
        },
    });
    let warned = 0;
    let destroyed = 0;
    for (const machine of candidates) {
        const idleDaysSoFar = (now - idleSince(machine).getTime()) / DAY_MS;
        if (idleDaysSoFar < idleWarnDays) {
            continue;
        }
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
            if (await premiumOf(prisma, config, machine.sandbox.ownerId)) {
                continue;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
            const state = await getMachine(config.hosted.flyApiToken, machine.appName, machine.machineId);
            if (LIVE_STATES.has(state.state)) {
                // Up and working despite a stale announce. Re-arm so it gets a full warning period whenever
                // it does eventually stop.
                if (machine.idleWarnedAt !== null) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep
                    await prisma.hostedMachine.update({ where: { id: machine.id }, data: { idleWarnedAt: null } });
                }
                continue;
            }
            if (idleDaysSoFar >= idleDays) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- sequential teardown
                await destroyHosted(config, machine.appName);
                // The row goes with the machine; the SANDBOX stays, which is what lets its owner give it a new
                // machine without losing the name, the address or who it is shared with.
                // oxlint-disable-next-line eslint/no-await-in-loop -- sequential teardown
                await prisma.hostedMachine.delete({ where: { id: machine.id } });
                destroyed += 1;
                logger.warn(
                    { app: machine.appName, sandboxId: machine.sandbox.id, idleDays: Math.floor(idleDaysSoFar) },
                    `hosted idle sweep: machine collected`,
                );
                continue;
            }
            if (machine.idleWarnedAt === null) {
                // Mail first, stamp second: a stamp written before a send that then failed would silently
                // consume this machine's one warning and delete it unannounced a week later.
                // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep
                await sendMail(config, logger, {
                    to: machine.sandbox.owner.email,
                    ...warnMail(config, machine.sandbox.name, Math.max(1, Math.ceil(idleDays - idleDaysSoFar))),
                });
                // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep
                await prisma.hostedMachine.update({ where: { id: machine.id }, data: { idleWarnedAt: new Date() } });
                warned += 1;
            }
        } catch (error) {
            logger.error({ err: error, app: machine.appName }, `hosted idle sweep: failed for this machine; retried tomorrow`);
        }
    }
    return { warned, destroyed };
};
