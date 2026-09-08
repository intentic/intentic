import type { AdminActionResult } from "@intentic/api-contract";
import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../config.js";
import { stopMachine } from "../sandbox/hosted/fly/fly.js";
import { destroyHosted, hostedEnabled } from "../sandbox/hosted/hosted.js";
import { cancelHostedPlan } from "../sandbox/hosted/hosted-plan.js";
import type { StripeGateway } from "../sandbox/hosted/hosted-plan-stripe.js";

// Admin mutations, gated by routes (requireAdmin, the ADMIN_MUTATIONS switch, typed confirmation). Each action reuses
// the owner's own teardown flows rather than inventing a new way to touch machines.

// Stops, not destroys: the volume, row and owner's wake-back-in all survive; the hour meter's daily settle closes the
// stretch.
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
        return { ok: false, message: `Fly refused the stop: ${errorMessage(error)}` };
    }
    return { ok: true, message: `${machine.appName} stopped. The owner's next visit wakes it; nothing was destroyed.` };
};

// Same teardown as the owner's own delete. Cancels the Stripe subscription first, while the plan row still names it,
// since it does not cascade with the row.
export const deleteUserAccount = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    userId: string,
    // Injectable so tests drive the cancel without Stripe, as in the plan routes.
    gateway?: StripeGateway,
): Promise<AdminActionResult> => {
    const sandboxes = await prisma.sandbox.findMany({
        where: { ownerId: userId },
        select: { id: true, hosted: { select: { appName: true } } },
    });
    await cancelHostedPlan(prisma, config, logger, userId, gateway);
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
    return { ok: true, message: `${user.email} erased: sandboxes, grants and the hosted plan are gone with the account.` };
};
