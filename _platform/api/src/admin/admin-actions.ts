import type { AdminActionResult } from "@intentic/api-contract";
import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../config.js";
import { stopMachine } from "../sandbox/hosted/fly/fly.js";
import { destroyHosted, hostedEnabled } from "../sandbox/hosted/hosted.js";
import { cancelHostedPlan } from "../sandbox/hosted/hosted-plan.js";
import type { StripeGateway } from "../sandbox/hosted/hosted-plan-stripe.js";

/* THE ADMIN MUTATIONS — the only writes on the admin surface, behind three gates the ROUTES enforce
 * (requireAdmin, the ADMIN_MUTATIONS switch, the typed confirmation); what lives here is the action itself,
 * each answering a sentence the panel shows verbatim. Every action is a reuse of the exact teardown the owner's
 * own flows run — nothing in this file invents a new way to touch machines. */

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
        return { ok: false, message: `Fly refused the stop: ${errorMessage(error)}` };
    }
    return { ok: true, message: `${machine.appName} stopped. The owner's next visit wakes it; nothing was destroyed.` };
};

/* GDPR erasure from the operator's side (Art. 17 requests that arrive by email rather than through
 * Settings). The same teardown per sandbox as the owner's own delete — the rows go, which is itself what
 * revokes their reachability (reachability.ts: the ingress refuses a tunnel whose sandbox is not here), and
 * the hosted machines are destroyed after. Teardown failures downgrade to the reaper's problem exactly as they
 * do in the owner flow: an app with no row is what the daily hosted reap destroys. The Stripe subscription is
 * cancelled FIRST, while the plan row still names it: it is the one thing about an account that is not a row
 * of ours and does not cascade (hosted-plan.ts). */
export const deleteUserAccount = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    userId: string,
    // Injectable so tests drive the cancel without Stripe, the plan routes' precedent.
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
