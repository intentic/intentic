import type { AdminActionResult } from "@intentic/api-contract";
import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../config.js";
import { stopMachine } from "../sandbox/hosted/fly/fly.js";
import { eraseAccount } from "../account-erase.js";
import { hostedEnabled } from "../sandbox/hosted/hosted.js";
import type { StripeGateway } from "../sandbox/hosted/hosted-plan-stripe.js";
import { hostedSuspensionOf, liftHostedSuspension, suspendHosted } from "../sandbox/hosted/abuse/hosted-standing.js";

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

// The owner's own deletion, run by an operator: the one erase path (account-erase.ts) queues and destroys the hosted
// apps, ends the Stripe customer and carries the hosted standing, and then the user row goes.
export const deleteUserAccount = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    userId: string,
    // Injectable so tests drive the Stripe erasure without Stripe, as in the plan routes.
    gateway?: StripeGateway,
): Promise<AdminActionResult> => {
    const erased = await eraseAccount(prisma, config, logger, userId, gateway === undefined ? {} : { gateway });
    const user = await prisma.user.delete({ where: { id: userId }, select: { email: true } });
    const pending = erased.apps.length - erased.destroyed.length;
    return {
        ok: true,
        message: `${user.email} erased: sandboxes, grants and the hosted plan are gone with the account${
            pending === 0 ? `` : `; ${pending === 1 ? `one hosted app is` : `${pending} hosted apps are`} queued for teardown`
        }${erased.stripe === `queued` ? `; the Stripe customer is queued for deletion` : ``}.`,
    };
};

// Switches the hosted lane off for one account and stops its machines now (hosted-standing.ts); the account, its
// own-machine sandboxes and its files are untouched, which the sentence says.
export const suspendUserHosted = async (prisma: PrismaClient, config: Config, logger: Logger, user: { id: string; email: string }, reason: string): Promise<AdminActionResult> => {
    if (!hostedEnabled(config)) {
        return { ok: false, message: `The hosted lane is not configured on this platform.` };
    }
    if ((await hostedSuspensionOf(prisma, config, user.id)) !== undefined) {
        return { ok: false, message: `${user.email} is already suspended.` };
    }
    const { stopped } = await suspendHosted(prisma, config, logger, user.id, reason);
    return {
        ok: true,
        message: `${user.email} suspended: no hosted machine starts for this account until lifted; ${stopped === 1 ? `one running machine was` : `${stopped} running machines were`} stopped. Nothing else about the account changes.`,
    };
};

export const liftUserHosted = async (prisma: PrismaClient, config: Config, logger: Logger, user: { id: string; email: string }): Promise<AdminActionResult> => {
    if ((await hostedSuspensionOf(prisma, config, user.id)) === undefined) {
        return { ok: false, message: `${user.email} is not suspended.` };
    }
    await liftHostedSuspension(prisma, config, logger, user.id);
    return { ok: true, message: `${user.email} is back in good standing; the owner's next visit wakes their machine.` };
};
