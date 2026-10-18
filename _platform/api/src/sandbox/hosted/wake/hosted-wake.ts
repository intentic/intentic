import { hostedTier } from "@intentic/constants";
import type { HostedMachine } from "@intentic/prisma";
import { ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../../context.js";
import { decryptSecret } from "../../../crypto.js";
import { openStretchOrStop, requireHostedStanding } from "../../hosted-changes.js";
import { hoursSpent, paymentRequired } from "../../hosted-refusals.js";
import { isFlyGone } from "../fly/fly.js";
import { HostedMachineBusy } from "../gate/state-gate.js";
import { forgetHostedMachine, wakeHosted } from "../hosted.js";
import { hostedBudgetOf, settleHostedStretch } from "../hosted-usage.js";

export type HostedWakeContext = Pick<OrpcContext, "prisma" | "config" | "logger">;
export interface HostedWakeSandbox {
    readonly id: string;
    readonly ownerId: string;
    readonly token: string;
    readonly owner: { readonly email: string };
    readonly hosted: HostedMachine;
}

// The same admission, state gate and billing for a browser's wake and a durable alarm. An alarm is the owner's earlier
// request; it cannot bypass a suspension, spent hours, a move, a removal or a failed image's rollback.
export const wakeHostedSandbox = async (context: HostedWakeContext, sandbox: HostedWakeSandbox): Promise<void> => {
    const { hosted } = sandbox;
    await requireHostedStanding(context, sandbox.ownerId);
    await settleHostedStretch(context.prisma, context.config, context.logger, { ...hosted, ownerId: sandbox.ownerId });
    const budget = await hostedBudgetOf(context.prisma, context.config, { sandboxId: sandbox.id, ownerId: sandbox.ownerId });
    if (budget.metered && budget.remainingMinutes === 0) {
        throw paymentRequired(hoursSpent(budget, "anyone"));
    }
    try {
        const healed = await wakeHosted(context.config, hosted, () => ({
            sandboxId: sandbox.id,
            connectToken: decryptSecret(context.config, sandbox.token),
            ownerEmail: sandbox.owner.email.toLowerCase(),
            region: hosted.region,
            tier: hostedTier(hosted.tier).id,
        }), context.logger, { prisma: context.prisma, hostedMachineId: hosted.id, sandboxId: sandbox.id });
        if (healed) {
            context.logger.info({ app: hosted.appName, sandboxId: sandbox.id }, "hosted wake: stale tunnel configuration was re-applied");
        }
    } catch (error) {
        if (isFlyGone(error)) {
            await forgetHostedMachine(context.prisma, { ...hosted, ownerId: sandbox.ownerId });
            context.logger.warn({ app: hosted.appName, sandboxId: sandbox.id }, "hosted wake: the provider has no such machine; its row and address were dropped");
            throw new ORPCError("NOT_FOUND", { message: "the machine this sandbox ran on no longer exists; give it a new one from setup" });
        }
        if (error instanceof HostedMachineBusy) {
            throw new ORPCError("CONFLICT", { message: error.message });
        }
        throw new ORPCError("BAD_GATEWAY", { message: error instanceof Error ? error.message : "waking the machine failed" });
    }
    await openStretchOrStop(context, hosted, sandbox.ownerId);
};
