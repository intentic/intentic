import { LEGAL_CONTACT_EMAIL } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { stopOwnerMachines } from "./hosted-meter.js";

// An account's standing on the hosted lane. Suspended means no machine is provisioned, woken, restarted or rebuilt for
// it and any awake one is stopped; the account itself, its own-machine sandboxes and its data are untouched. Written by
// an operator (admin-actions.ts) or by the abuse watch's second strike (hosted-abuse.ts); lifted only by an operator.

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

export const hostedSuspensionOf = async (prisma: Pick<PrismaClient, "user">, userId: string): Promise<HostedSuspension | undefined> => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { hostedSuspendedAt: true, hostedSuspendedReason: true } });
    if (user === null || user.hostedSuspendedAt === null) {
        return undefined;
    }
    return { at: user.hostedSuspendedAt, reason: user.hostedSuspendedReason ?? `acceptable use` };
};

// The gate every hosted act passes first; `userId` is the OWNER of the machine, never the caller.
export const assertHostedStanding = async (prisma: Pick<PrismaClient, "user">, userId: string): Promise<void> => {
    const suspension = await hostedSuspensionOf(prisma, userId);
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

export const liftHostedSuspension = async (prisma: PrismaClient, logger: Logger, userId: string): Promise<void> => {
    await prisma.user.update({ where: { id: userId }, data: { hostedSuspendedAt: null, hostedSuspendedReason: null } });
    logger.warn({ userId }, `hosted standing: suspension lifted`);
};
