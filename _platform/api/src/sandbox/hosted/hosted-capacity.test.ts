import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { forgetProviderCapacity, hostedCapacity, noteProviderAtCapacity } from "./hosted-capacity.js";

// Whether a machine is left to give, checked before anything is spent, so a full provider never surfaces as a raw
// gateway error.

const IMAGE = `ghcr.io/intentic/sandbox:stable`;

const config = (maxMachines: number): Config => ({ hosted: { maxMachines, image: IMAGE } }) as unknown as Config;

// pool is asked twice: once for the whole pool, once (with a `where`) for claimable stock, and the stub matches.
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
    it(`asks the database nothing when there is no ceiling and nothing has been refused`, async () => {
        const { prisma, counts } = fakePrisma({ machines: 40 });
        const capacity = await hostedCapacity(prisma, config(0));
        expect(capacity).toEqual({ cap: 0, used: undefined, headroom: Number.POSITIVE_INFINITY, warm: 0, full: false, reason: undefined });
        expect(counts.machines).not.toHaveBeenCalled();
        expect(counts.pool).not.toHaveBeenCalled();
        expect(counts.builds).not.toHaveBeenCalled();
    });

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

    // Warm stock is served even at the ceiling; headroom stays 0, since new building would take an arrival's own slot.
    it(`is not full while there is warm stock to hand over`, async () => {
        const { prisma } = fakePrisma({ machines: 98, pooled: 2, ready: 2 });
        const capacity = await hostedCapacity(prisma, config(100), `iad`);
        expect(capacity.warm).toBe(2);
        expect(capacity.headroom).toBe(0);
        expect(capacity.full).toBe(false);
    });

    it(`believes a refusal only in the region it came from, and only for a few minutes`, async () => {
        const { prisma } = fakePrisma({ machines: 12 });
        const at = Date.UTC(2026, 0, 1, 12, 0, 0);
        noteProviderAtCapacity(`arn`, at);
        expect((await hostedCapacity(prisma, config(0), `arn`, at + 60_000)).full).toBe(true);
        expect((await hostedCapacity(prisma, config(0), `arn`, at + 60_000)).reason).toBe(`provider`);
        expect((await hostedCapacity(prisma, config(0), `iad`, at + 60_000)).full).toBe(false);
        // Past the window, belief lapses on its own, without anybody deploying anything.
        expect((await hostedCapacity(prisma, config(0), `arn`, at + 6 * 60_000)).full).toBe(false);
    });

    it(`answers a region-less question with any region's refusal`, async () => {
        const { prisma } = fakePrisma({ machines: 12 });
        const at = Date.UTC(2026, 0, 1, 12, 0, 0);
        noteProviderAtCapacity(`arn`, at);
        expect((await hostedCapacity(prisma, config(0), undefined, at + 60_000)).full).toBe(true);
    });
});
