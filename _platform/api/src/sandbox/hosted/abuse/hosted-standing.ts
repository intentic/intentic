import { LEGAL_CONTACT_EMAIL } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../../config.js";
import { stopOwnerMachines } from "../hosted-meter.js";
import {
    CARRIED_SUSPENSION_REASON,
    carriedStandingOf,
    GOOGLE_SUBJECT_SELECT,
    googleSubjectOf,
    standingSubjectHash,
} from "./carried-standing.js";

// An account's standing on the hosted lane. Suspended means no machine is provisioned, woken, restarted or rebuilt for
// it and any awake one is stopped; the account itself, its own-machine sandboxes and its data are untouched. Written by
// an operator (admin-actions.ts) or by the abuse watch's second strike (hosted-abuse.ts); lifted only by an operator.
//
// A deleted account's standing is carried onto the next account with its Google subject (carried-standing.ts): every
// read here adds it, and a lift clears it too.

export interface HostedSuspension {
    readonly at: Date;
    readonly reason: string;
}

// Thrown where a hosted act would have begun; the route answers FORBIDDEN in these words.
export class HostedSuspended extends Error {
    readonly suspension: HostedSuspension;

    constructor(suspension: HostedSuspension) {
        super(suspendedMessage(suspension));
        this.suspension = suspension;
    }
}

// Addressed to whoever reads it: says what is off, why, that their own computer is not, and where to write.
export const suspendedMessage = (suspension: HostedSuspension): string =>
    `hosted sandboxes are switched off for this account (${suspension.reason}). A sandbox on your own computer is unaffected; write to ${LEGAL_CONTACT_EMAIL} if you think this is wrong`;

// The account's own suspension first, then one carried from a deleted account with the same Google subject.
export const hostedSuspensionOf = async (
    prisma: Pick<PrismaClient, "user" | "hostedStanding">,
    config: Pick<Config, "betterAuth">,
    userId: string,
): Promise<HostedSuspension | undefined> => {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { hostedSuspendedAt: true, hostedSuspendedReason: true, ...GOOGLE_SUBJECT_SELECT },
    });
    if (user === null) {
        return undefined;
    }
    if (user.hostedSuspendedAt !== null) {
        return { at: user.hostedSuspendedAt, reason: user.hostedSuspendedReason ?? `acceptable use` };
    }
    const carried = await carriedStandingOf(prisma, config, user.accounts);
    return carried?.suspendedAt == null ? undefined : { at: carried.suspendedAt, reason: CARRIED_SUSPENSION_REASON };
};

// The gate every hosted act passes first; `userId` is the OWNER of the machine, never the caller.
export const assertHostedStanding = async (
    prisma: Pick<PrismaClient, "user" | "hostedStanding">,
    config: Pick<Config, "betterAuth">,
    userId: string,
): Promise<void> => {
    const suspension = await hostedSuspensionOf(prisma, config, userId);
    if (suspension !== undefined) {
        throw new HostedSuspended(suspension);
    }
};

// Suspends and stops every awake machine the account owns, so the verdict holds from this moment rather than from the
// owner's next wake. Answers how many machines were stopped; a stop Fly refuses is retried by the meter's tick.
export const suspendHosted = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    userId: string,
    reason: string,
    now: Date = new Date(),
): Promise<{ stopped: number }> => {
    await prisma.user.update({ where: { id: userId }, data: { hostedSuspendedAt: now, hostedSuspendedReason: reason } });
    const machines = await prisma.hostedMachine.findMany({
        where: { sandbox: { ownerId: userId } },
        select: { id: true, appName: true, machineId: true, sandbox: { select: { ownerId: true } } },
    });
    const stopped = await stopOwnerMachines(config, logger, machines, `its owner's hosted lane is suspended`);
    logger.warn({ userId, reason, stopped }, `hosted standing: account suspended`);
    return { stopped };
};

// Lifts the account's own suspension and one carried onto it, which an operator could otherwise never reach.
export const liftHostedSuspension = async (prisma: PrismaClient, config: Pick<Config, "betterAuth">, logger: Logger, userId: string): Promise<void> => {
    const user = await prisma.user.update({
        where: { id: userId },
        data: { hostedSuspendedAt: null, hostedSuspendedReason: null },
        select: GOOGLE_SUBJECT_SELECT,
    });
    const subject = googleSubjectOf(user.accounts);
    if (subject !== undefined) {
        await prisma.hostedStanding.updateMany({ where: { subjectHash: standingSubjectHash(config, subject) }, data: { suspendedAt: null } });
    }
    logger.warn({ userId }, `hosted standing: suspension lifted`);
};
