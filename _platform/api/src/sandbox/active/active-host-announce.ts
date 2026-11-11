import type { ActiveHost, HostManager, Takeover } from "@intentic/api-contract";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import { type ActiveDecision, activeHostOf, decideActive } from "./active-host.js";
import type { AnnouncedCopy } from "../announce-copies.js";

/* THE ANNOUNCE ROUTE'S SIDE OF ONE ACTIVE HOST PER SANDBOX: applies active-host.ts's decision to the row and answers the
 * daemon with where it stands. A move is written only over the row as it was read (the same epoch, and still no active
 * host for rule (a)), so two copies announcing at once cannot both win; the loser reads the row again and is told the
 * winner. */

export interface ActiveAnswer {
    readonly active?: boolean;
    readonly activeHost?: ActiveHost;
    readonly activeEpoch?: number;
}

interface ActiveRow {
    readonly id: string;
    readonly activeHost: Prisma.JsonValue | null;
    readonly activeEpoch: number;
}

// The answer's fields for a decision: nothing at all while the platform cannot place the copy.
const answerOf = (decision: Pick<ActiveDecision, "active" | "activeHost" | "activeEpoch">): ActiveAnswer =>
    decision.active === undefined || decision.activeHost === null
        ? {}
        : { active: decision.active, activeHost: decision.activeHost, activeEpoch: decision.activeEpoch };

export const announceActive = async (
    prisma: PrismaClient,
    { sandbox, copy, body, now, logger }: {
        sandbox: ActiveRow;
        copy: AnnouncedCopy | undefined;
        body: { readonly manager?: HostManager; readonly takeover?: Takeover };
        now: Date;
        logger: Logger;
    },
): Promise<ActiveAnswer> => {
    const held = { activeHost: activeHostOf(sandbox.activeHost), activeEpoch: sandbox.activeEpoch };
    const decision = decideActive(held, copy, { manager: body.manager, takeover: body.takeover }, now);
    if (!decision.changed || decision.activeHost === null) {
        return answerOf(decision);
    }
    const where: Prisma.SandboxWhereInput = { id: sandbox.id, activeEpoch: sandbox.activeEpoch };
    if (held.activeHost === null) {
        where.activeHost = { equals: Prisma.DbNull };
    }
    const moved = await prisma.sandbox.updateMany({ where, data: { activeHost: decision.activeHost, activeEpoch: decision.activeEpoch } });
    if (moved.count === 1) {
        logger.info(
            { sandboxId: sandbox.id, activeHost: decision.activeHost, activeEpoch: decision.activeEpoch, takeover: body.takeover?.by },
            `announce: this copy is now the one that runs the sandbox`,
        );
        return answerOf(decision);
    }
    // Another announce moved it first: this copy is told where it stands against the row as that one left it.
    const fresh = await prisma.sandbox.findUnique({ where: { id: sandbox.id }, select: { activeHost: true, activeEpoch: true } });
    if (fresh === null) {
        return {};
    }
    return answerOf(decideActive({ activeHost: activeHostOf(fresh.activeHost), activeEpoch: fresh.activeEpoch }, copy, {}, now));
};
