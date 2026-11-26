import { FREE_TIER, PAID_TIERS, type HostedTier } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import { configSchema } from "../../../config.js";
import { applyDuePlanChanges, runPlanChange } from "./hosted-plan-changes.js";

// When a waiting plan change is applied: a downgrade not under somebody working in the sandbox, a failed resize not
// asked again every ten minutes, and a change already in place cleared rather than resized for nothing.

const NOW = new Date(`2026-12-26T14:00:00Z`);
const HOUR_MS = 60 * 60 * 1000;
const standard = (): HostedTier => {
    const tier = PAID_TIERS[0];
    if (tier === undefined) {
        throw new Error(`these tests need a paid rung`);
    }
    return tier;
};
const STANDARD = standard();

// No Fly token: a resize this reaches is refused at once ("this platform does not run hosted machines"), so these
// tests see which machines the job tried, never a provider call.
const config = configSchema.parse({ database: { url: `postgres://x` }, betterAuth: { secret: `s` }, webOrigin: `https://app.test` });
const logger = unstubbed<Logger>(`logger`, { info: jest.fn(), warn: jest.fn(), error: jest.fn() });

interface Due {
    sandboxId: string;
    tier: string;
    planTo: string;
    planAt: Date;
    wokeAt: Date | null;
    lastFinishedAt?: Date;
}

const job = (due: Due[]) => {
    const findUnique = jest.fn(async (_args: { where: { sandboxId: string } }) => null);
    const fake = {
        hostedMachine: { findMany: jest.fn(async () => due), findUnique },
        hostedMigration: {
            findFirst: jest.fn(async ({ where }: { where: { sandboxId: string } }) => {
                const finishedAt = due.find((row) => row.sandboxId === where.sandboxId)?.lastFinishedAt;
                return finishedAt === undefined ? null : { finishedAt };
            }),
        },
    };
    // SAFETY: the job reads only the due machines, each one's latest migration and, per machine it tries, that machine;
    // any other member throws by name.
    const prisma = unstubbed<PrismaClient>(`prisma`, fake as never);
    return { prisma, tried: () => findUnique.mock.calls.map(([args]) => args.where.sandboxId) };
};

describe(`applying the plan changes that are due`, () => {
    it(`waits for an awake machine to sleep before a downgrade, but not past the grace`, async () => {
        const { prisma, tried } = job([
            { sandboxId: `awake`, tier: STANDARD.id, planTo: FREE_TIER.id, planAt: new Date(NOW.getTime() - HOUR_MS), wokeAt: NOW },
            { sandboxId: `asleep`, tier: STANDARD.id, planTo: FREE_TIER.id, planAt: new Date(NOW.getTime() - HOUR_MS), wokeAt: null },
            { sandboxId: `long-awake`, tier: STANDARD.id, planTo: FREE_TIER.id, planAt: new Date(NOW.getTime() - 7 * HOUR_MS), wokeAt: NOW },
        ]);
        expect(await applyDuePlanChanges(prisma, config, logger, NOW)).toBe(2);
        expect(tried()).toEqual([`asleep`, `long-awake`]);
    });

    it(`tries a failed upgrade again only once its last attempt is half an hour old`, async () => {
        const { prisma, tried } = job([
            { sandboxId: `just-failed`, tier: FREE_TIER.id, planTo: STANDARD.id, planAt: NOW, wokeAt: null, lastFinishedAt: new Date(NOW.getTime() - 5 * 60_000) },
            { sandboxId: `failed-long-ago`, tier: FREE_TIER.id, planTo: STANDARD.id, planAt: NOW, wokeAt: null, lastFinishedAt: new Date(NOW.getTime() - HOUR_MS) },
        ]);
        await applyDuePlanChanges(prisma, config, logger, NOW);
        expect(tried()).toEqual([`failed-long-ago`]);
    });
});

describe(`one sandbox's waiting change`, () => {
    it(`clears a change the machine already stands on, without resizing it, and keeps it paid on a paid tier`, async () => {
        const updateMany = jest.fn(async (_args: object) => ({ count: 1 }));
        const machine = { sandboxId: `s1`, tier: STANDARD.id, paid: true, planTo: STANDARD.id, planAt: NOW };
        // SAFETY: a change already in place is cleared from the machine's own row and nothing else is read.
        const prisma = unstubbed<PrismaClient>(`prisma`, { hostedMachine: { findUnique: jest.fn(async () => machine), updateMany } } as never);
        await runPlanChange(prisma, config, logger, `s1`);
        expect(updateMany.mock.calls).toEqual([[{ where: { sandboxId: `s1`, planTo: STANDARD.id }, data: { planTo: null, planAt: null, paid: true } }]]);
    });
});
