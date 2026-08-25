import type { AdminActionResult } from "@intentic-app/api-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import { decryptSecret } from "../crypto.js";
import { stopMachine } from "../sandbox/hosted/fly.js";
import { destroyHosted, hostedEnabled } from "../sandbox/hosted/hosted.js";
import { deleteSandboxAccount } from "../sandbox/zrok.js";
import { zrokEnabled } from "../sandbox/zrok-provision.js";

/* THE ADMIN MUTATIONS — the only writes on the admin surface, behind three gates the ROUTES enforce
 * (requireAdmin, the ADMIN_MUTATIONS switch, the typed confirmation); what lives here is the action itself,
 * each answering a sentence the panel shows verbatim. Every action is either a plain status flip the daily
 * jobs already know how to live with, or a reuse of the exact teardown the owner's own flows run — nothing
 * in this file invents a new way to touch money or machines. */

// Suspend a listing, in the operator's own words. The same state the watch's automatic suspension reaches,
// so everything downstream (catalog absence, provider's creator screen, re-publish path) already handles it.
export const suspendService = async (prisma: PrismaClient, slug: string, reason: string): Promise<AdminActionResult> => {
    const service = await prisma.service.findUnique({ where: { slug }, select: { status: true } });
    if (service === null) {
        return { ok: false, message: `No service with slug “${slug}”.` };
    }
    if (service.status === `suspended`) {
        return { ok: false, message: `“${slug}” is already suspended.` };
    }
    await prisma.service.update({ where: { slug }, data: { status: `suspended`, suspendedFor: `Suspended by the operator: ${reason}` } });
    return { ok: true, message: `“${slug}” suspended. The reason is recorded where the provider will read it.` };
};

/* Reinstate into PROBATION, never straight to `listed`: the price ceiling and the badge are exactly what a
 * listing that was just suspended should re-enter under, and graduation is the watch's call, not this
 * button's. Canary count resets — the failures it counted belong to the suspended era. */
export const reinstateService = async (prisma: PrismaClient, slug: string): Promise<AdminActionResult> => {
    const service = await prisma.service.findUnique({ where: { slug }, select: { status: true } });
    if (service === null) {
        return { ok: false, message: `No service with slug “${slug}”.` };
    }
    if (service.status !== `suspended`) {
        return { ok: false, message: `“${slug}” is ${service.status}, not suspended — nothing to reinstate.` };
    }
    await prisma.service.update({ where: { slug }, data: { status: `probation`, suspendedFor: null, canaryFails: 0 } });
    return { ok: true, message: `“${slug}” reinstated into probation, under the probation price ceiling and the watch.` };
};

// Stop a hosted machine — the cost/abuse brake. Deliberately NOT destroy: the volume, the row and the
// owner's way back in (wake) all survive, and the hour meter's daily settle closes the stretch.
export const stopHostedMachine = async (prisma: PrismaClient, config: Config, sandboxId: string): Promise<AdminActionResult> => {
    if (!hostedEnabled(config)) {
        return { ok: false, message: `The hosted lane is not configured on this platform.` };
    }
    const machine = await prisma.hostedMachine.findUnique({ where: { sandboxId }, select: { appName: true, machineId: true } });
    if (machine === null) {
        return { ok: false, message: `Sandbox ${sandboxId} has no hosted machine.` };
    }
    try {
        await stopMachine(config.hosted.flyApiToken, machine.appName, machine.machineId);
    } catch (error) {
        return { ok: false, message: `Fly refused the stop: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, message: `${machine.appName} stopped. The owner's next visit wakes it; nothing was destroyed.` };
};

/* GDPR erasure from the operator's side (Art. 17 requests that arrive by email rather than through
 * Settings). The same teardown per sandbox as the owner's own delete — reachability grant off the hub,
 * hosted machine destroyed — then the user row goes and the cascade takes everything else. Teardown
 * failures downgrade to the reaper's problem exactly as they do in the owner flow: an app with no row is
 * what the daily hosted reap destroys. */
export const deleteUserAccount = async (prisma: PrismaClient, config: Config, logger: Logger, userId: string): Promise<AdminActionResult> => {
    const sandboxes = await prisma.sandbox.findMany({
        where: { ownerId: userId },
        select: { id: true, token: true, zrokToken: true, hosted: { select: { appName: true } } },
    });
    for (const sandbox of sandboxes) {
        if (sandbox.zrokToken !== null && zrokEnabled(config)) {
            try {
                await deleteSandboxAccount(config.zrok, sandboxIdFromToken(decryptSecret(config, sandbox.token)) ?? sandbox.id);
            } catch (error) {
                logger.error({ err: error, sandboxId: sandbox.id }, `admin delete: zrok teardown failed, grant orphaned`);
            }
        }
    }
    const user = await prisma.user.delete({ where: { id: userId }, select: { email: true } });
    for (const sandbox of sandboxes) {
        if (sandbox.hosted !== null) {
            try {
                await destroyHosted(config, sandbox.hosted.appName);
            } catch (error) {
                logger.warn({ err: error, app: sandbox.hosted.appName }, `admin delete: hosted teardown failed; orphaned for the reaper`);
            }
        }
    }
    return { ok: true, message: `${user.email} erased: sandboxes, grants, memberships and ledger links are gone with the account.` };
};
