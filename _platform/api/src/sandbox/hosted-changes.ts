import { FREE_TIER, hostedTier } from "@intentic/constants";
import { ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { decryptSecret } from "../crypto.js";
import { requireOwnedSandbox, requireUser } from "../guards.js";
import { isFlyGone, stopMachine } from "./hosted/fly/fly.js";
import { type HostedProvisionArgs, provisionHosted, refreshHosted, slotsMessage } from "./hosted/hosted.js";
import type { HostedImageKept } from "./hosted/gate/state-gate.js";
import { withHostedAppLock } from "./hosted/hosted-app-lock.js";
import { hostedSlotUse } from "./hosted/plan/hosted-plan.js";
import { assertHostedSource, HostedSourceCapped } from "./hosted/abuse/hosted-source.js";
import { assertHostedStanding, HostedSuspended } from "./hosted/abuse/hosted-standing.js";
import { dropHostedMachine, hostedArrivalBudget, hostedBudgetOf, openHostedStretch, settleHostedStretch } from "./hosted/hosted-usage.js";
import { type AdmittedArrival, googleRequired, type HostedArrival } from "./hosted/free-lane.js";
import { hoursSpent, paymentRequired } from "./hosted-refusals.js";

// WHAT THE HOSTED ROUTES STAND ON around a machine they restart, roll back, wake or create: the owner's standing, the
// stop and settle before a change, a start whose row went missing, and the gates a new machine passes. Apart from the
// routes (sandbox.routes.ts) so the file of procedures reads as procedures.

// The hosted lane is switched off for the machine's OWNER (hosted-standing.ts): FORBIDDEN, in the suspension's own
// words, for every act that would start a machine. Checked before anything is settled, counted or built.
export const requireHostedStanding = async (context: Pick<OrpcContext, "prisma" | "config">, ownerId: string): Promise<void> => {
    try {
        await assertHostedStanding(context.prisma, context.config, ownerId);
    } catch (error) {
        if (error instanceof HostedSuspended) {
            throw new ORPCError(`FORBIDDEN`, { message: error.message });
        }
        throw error;
    }
};

// The state gate kept the machine on the version it had (a target that cannot convert its state, or one that did not
// start): the owner reads why, and a machine running there is metered like any restart.
export const keptVersion = async (
    context: OrpcContext,
    hosted: { id: string; sandboxId: string; appName: string; machineId: string },
    ownerId: string,
    kept: HostedImageKept,
): Promise<ORPCError<string, unknown>> => {
    if (kept.running) {
        await openStretchOrStop(context, hosted, ownerId);
    }
    return new ORPCError(kept.reason === `refused` ? `CONFLICT` : `BAD_GATEWAY`, { message: kept.message });
};

// Reboots the machine, or replaces it when Fly says it's gone. The dead row is deleted before reprovisioning:
// `sandboxId` is unique on HostedMachine, so keeping it would fail the new machine's write and strand the owner. The
// replacement adopts the sandbox's own app when the provider still holds it, so a machine lost with its disk intact
// comes back on that disk (hosted.ts adoptHostedApp, 2026-10-05) instead of failing at createApp.
export const restartOrRebuild = async (
    context: OrpcContext,
    args: HostedProvisionArgs,
    hosted: {
        id: string;
        appName: string;
        machineId: string;
        volumeId: string;
        image?: string | null;
        environmentHash?: string | null;
        skippedDigest?: string | null;
    },
    ownerId: string,
): Promise<boolean> => {
    try {
        await refreshHosted(context.config, args, hosted, context.logger, {
            prisma: context.prisma,
            hostedMachineId: hosted.id,
            sandboxId: args.sandboxId,
        });
        return false;
    } catch (error) {
        if (!isFlyGone(error)) {
            throw error;
        }
        context.logger.warn(
            { app: hosted.appName, sandboxId: args.sandboxId },
            `hosted restart: the machine is gone from the provider; building a replacement for this sandbox`,
        );
        await context.prisma.$transaction((tx) => dropHostedMachine(tx, { id: hosted.id, sandboxId: args.sandboxId, ownerId }));
        await provisionHosted(context.prisma, context.config, context.logger, args);
        return true;
    }
};

// The caller's own sandbox and the machine we run for it: the owner-only changes (a restart, a rollback) start here.
export const ownedHostedMachine = async (context: OrpcContext, sandboxId: string) => {
    const sandbox = await requireOwnedSandbox(context, sandboxId);
    const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: sandbox.id } });
    if (hosted === null) {
        throw new ORPCError(`NOT_FOUND`, { message: `this sandbox has no machine we run` });
    }
    return { sandbox, hosted, user: requireUser(context) };
};

/* WHAT A RESTART AND A ROLLBACK BOTH STAND ON: the owner in good standing, the machine stopped (so its stretch settles
 * exactly), and hours left to start it again. Answers the identity its config is composed from: the owner's address,
 * and the machine's own rung, since a change puts back the guest it had, never the one a new machine gets. */
export const stopForChange = async (
    context: OrpcContext,
    owned: Awaited<ReturnType<typeof ownedHostedMachine>>,
    what: string,
): Promise<HostedProvisionArgs> => {
    const { sandbox, hosted, user } = owned;
    await requireHostedStanding(context, sandbox.ownerId);
    // Never under another change's feet: its gate may be waiting for its own new daemon, and a stop now would read as that
    // version stopped from outside. This change waits its turn in its own gate, whose probe stops the machine.
    const stopped = await withHostedAppLock(context.config, hosted.appName, false, () =>
        stopMachine(context.config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch((error) =>
            context.logger.warn({ err: error, app: hosted.appName }, `hosted ${what}: stop refused; starting anyway`),
        ),
    );
    if (stopped === undefined) {
        context.logger.info({ app: hosted.appName }, `hosted ${what}: another change holds the machine; this one waits its turn`);
    }
    // Settling now is exact, since the stop just ended the stretch; the change ends in a start, so the budget applies
    // too.
    await settleHostedStretch(context.prisma, context.config, context.logger, { ...hosted, ownerId: sandbox.ownerId });
    const budget = await hostedBudgetOf(context.prisma, context.config, { sandboxId: sandbox.id, ownerId: sandbox.ownerId });
    if (budget.metered && budget.remainingMinutes === 0) {
        throw paymentRequired(hoursSpent(budget, `owner`));
    }
    return {
        sandboxId: sandbox.id,
        connectToken: decryptSecret(context.config, sandbox.token),
        ownerEmail: user.email.toLowerCase(),
        region: hosted.region,
        tier: hostedTier(hosted.tier).id,
    };
};

// A row gone mid-start (trash, release, the idle sweep) leaves nothing to bill the run, so the machine is stopped again.
export const openStretchOrStop = async (
    context: Pick<OrpcContext, "prisma" | "config" | "logger">,
    hosted: { id: string; sandboxId: string; appName: string; machineId: string },
    ownerId: string,
): Promise<void> => {
    if (await openHostedStretch(context.prisma, { ...hosted, ownerId })) {
        return;
    }
    await stopMachine(context.config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch((error) =>
        context.logger.error({ err: error, app: hosted.appName }, `hosted: a machine started after its row was deleted could not be stopped`),
    );
    throw new ORPCError(`NOT_FOUND`, { message: `this sandbox no longer has a machine we run` });
};

/* THE GATES A NEW HOSTED MACHINE PASSES, together because they are all refusals and none of them is about
 * provisioning. Standing first (a suspended account is told so before anything else), then the same-source caps
 * (hosted-source.ts), then this account's own slots and hours. */
export const assertHostedAllowance = async (
    context: OrpcContext,
    source: { readonly userId: string; readonly email: string; readonly ip: string | undefined },
    arrival: HostedArrival,
): Promise<AdmittedArrival> => {
    const { userId } = source;
    if (arrival.lane === `needs-google`) {
        throw googleRequired(`A free hosted machine`);
    }
    await requireHostedStanding(context, userId);
    // A machine arriving on a paid slot spends nothing of the free lane, so none of its limits below apply to it.
    if (arrival.lane === `slot`) {
        return arrival;
    }
    try {
        await assertHostedSource(context.prisma, context.config, source);
    } catch (error) {
        if (error instanceof HostedSourceCapped) {
            context.logger.warn({ userId, ip: source.ip }, `hosted provision: refused by a same-source cap`);
            throw new ORPCError(`TOO_MANY_REQUESTS`, { message: error.message });
        }
        throw error;
    }
    // An arrival lands on the free rung, so a paid slot never earns a second free machine; paid ones are reached by moving up.
    const { used, left } = await hostedSlotUse(context.prisma, context.config, userId, FREE_TIER.id);
    if (left <= 0) {
        throw new ORPCError(`BAD_REQUEST`, { message: slotsMessage(used) });
    }
    // The account's free hours, released machines' minutes included: letting one go never buys a fresh month.
    const budget = await hostedArrivalBudget(context.prisma, context.config, userId);
    if (budget.metered && budget.remainingMinutes === 0) {
        throw paymentRequired(hoursSpent(budget, `owner`));
    }
    return arrival;
};
