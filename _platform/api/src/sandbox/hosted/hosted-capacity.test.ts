import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { forgetProviderCapacity, hostedCapacity, noteProviderAtCapacity } from "./hosted-capacity.js";

/* THE CEILING THE HOSTED LANE LIVES UNDER. Everything here is about one question — is there a machine left to
 * give — asked before anybody presses anything, because the alternative is what used to happen: the provider
 * answering a create with "you have reached the maximum number of machines", the route relaying that as a
 * gateway error, and a browser arrival meeting both without having clicked at all. */

const IMAGE = `ghcr.io/intentic/sandbox:stable`;

const config = (maxMachines: number): Config => ({ hosted: { maxMachines, image: IMAGE } }) as unknown as Config;

/* The four reads the answer is made of. `pool` is asked twice — for the whole pool and, with a `where`, for
 * the stock that can actually be claimed — so the stub tells them apart the same way the query does. */
const fakePrisma = (fleet: { machines?: number; pooled?: number; building?: number; ready?: number } = {}) => {
    const pooled = fleet.pooled ?? 0;
    const ready = fleet.ready ?? 0;
    const counts = {
        machines: vi.fn().mockResolvedValue(fleet.machines ?? 0),
        pool: vi.fn().mockImplementation((args?: { where?: Record<string, unknown> }) => Promise.resolve(args?.where === undefined ? pooled : ready)),
        builds: vi.fn().mockResolvedValue(fleet.building ?? 0),
    };
    return {
        counts,
        prisma: {
            hostedMachine: { count: counts.machines },
            hostedPoolMachine: { count: counts.pool },
            hostedBuild: { count: counts.builds },
        } as never,
    };
};

beforeEach(() => {
    forgetProviderCapacity();
});

describe(`hostedCapacity`, () => {
    /* A platform that has set no ceiling has no question for the database to answer, and this is asked on the
     * hot path of every provision, every pool tick and every environment build. */
    it(`asks the database nothing when there is no ceiling and nothing has been refused`, async () => {
        const { prisma, counts } = fakePrisma({ machines: 40 });
        const capacity = await hostedCapacity(prisma, config(0));
        expect(capacity).toEqual({ cap: 0, used: undefined, headroom: Number.POSITIVE_INFINITY, warm: 0, full: false, reason: undefined });
        expect(counts.machines).not.toHaveBeenCalled();
        expect(counts.pool).not.toHaveBeenCalled();
        expect(counts.builds).not.toHaveBeenCalled();
    });

    // People's sandboxes, the warm stock waiting for them, and any builder in flight: all three are machines on
    // the provider's allowance, so all three are counted against it. A build that took the last slot would be
    // an environment change quietly costing the next sign-up their sandbox.
    it(`counts machines, stock and builders alike against the ceiling`, async () => {
        const { prisma } = fakePrisma({ machines: 90, pooled: 4, building: 2 });
        const capacity = await hostedCapacity(prisma, config(100));
        expect(capacity.used).toBe(96);
        expect(capacity.headroom).toBe(4);
        expect(capacity.full).toBe(false);
    });

    it(`is full at the ceiling, with the ceiling named as the reason`, async () => {
        const { prisma } = fakePrisma({ machines: 100 });
        const capacity = await hostedCapacity(prisma, config(100));
        expect(capacity).toMatchObject({ used: 100, headroom: 0, warm: 0, full: true, reason: `cap` });
    });

    /* STOCK OUTRANKS THE COUNTER, and this is the case worth being careful about: claiming a warm machine
     * creates nothing, so a fleet sitting exactly on its ceiling with stock in it can still serve the next
     * arrival in seconds. Refusing them because a number says "full" would turn people away from the one thing
     * that was, at that moment, working perfectly. Building is still refused (`headroom` is 0): the room that
     * is left belongs to arrivals, not to prewarming. */
    it(`is not full while there is warm stock to hand over`, async () => {
        const { prisma } = fakePrisma({ machines: 98, pooled: 2, ready: 2 });
        const capacity = await hostedCapacity(prisma, config(100), `iad`);
        expect(capacity.warm).toBe(2);
        expect(capacity.headroom).toBe(0);
        expect(capacity.full).toBe(false);
    });

    /* THE PROVIDER'S OWN REFUSAL, believed for a few minutes so the arrivals behind the first one are told
     * before they spend a failed round-trip finding out — and believed PER REGION, because an org allowance is
     * global and a region running out of hardware is not. A European sandbox may only be placed in the EEA
     * (the residency promise), so one bad afternoon in Stockholm must not tell Ashburn's readers that we are
     * out of machines while ninety of them sit free. */
    it(`believes a refusal only in the region it came from, and only for a few minutes`, async () => {
        const { prisma } = fakePrisma({ machines: 12 });
        const at = Date.UTC(2026, 0, 1, 12, 0, 0);
        noteProviderAtCapacity(`arn`, at);
        expect((await hostedCapacity(prisma, config(0), `arn`, at + 60_000)).full).toBe(true);
        expect((await hostedCapacity(prisma, config(0), `arn`, at + 60_000)).reason).toBe(`provider`);
        expect((await hostedCapacity(prisma, config(0), `iad`, at + 60_000)).full).toBe(false);
        // Past the window the platform stops believing it: a raised quota, a freed machine or a region coming
        // back must open the lane again without anybody deploying anything.
        expect((await hostedCapacity(prisma, config(0), `arn`, at + 6 * 60_000)).full).toBe(false);
    });

    // The watches (health, canary, the fleet report) name no region: they are asking whether anything is wrong
    // with placing machines at all, and one region that cannot take any is worth an operator's attention.
    it(`answers a region-less question with any region's refusal`, async () => {
        const { prisma } = fakePrisma({ machines: 12 });
        const at = Date.UTC(2026, 0, 1, 12, 0, 0);
        noteProviderAtCapacity(`arn`, at);
        expect((await hostedCapacity(prisma, config(0), undefined, at + 60_000)).full).toBe(true);
    });
});
