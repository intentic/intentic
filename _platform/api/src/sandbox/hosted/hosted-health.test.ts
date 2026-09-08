import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { forgetHostedHealthAlert, sweepHostedHealth } from "./hosted-health.js";

// Every other sweep here acts on the gap between the platform's rows and Fly, but never reported the gap itself. These
// tests pin what this watch has to say out loud.

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const config = (over: Record<string, unknown> = {}): Config =>
    ({
        webOrigin: `https://app.test`,
        api: { url: `https://api.test` },
        admin: { emails: `` },
        email: { apiKey: ``, from: `` },
        ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
        hosted: {
            flyApiToken: `fly`,
            flyOrg: `intentic`,
            appPrefix: `intentic-sbx`,
            region: `iad`,
            regionEu: `arn`,
            poolSize: 1,
            healthMinutes: 15,
            ...over,
        },
    }) as unknown as Config;

const stubApps = (...names: string[]) => {
    vi.stubGlobal(`fetch`, () => Promise.resolve(new Response(JSON.stringify({ apps: names.map((name) => ({ name })) }))));
};

// The org's app list and what each app runs, since ownership is now read off the provider, not a missing row.
const stubFly = (apps: string[], machines: Record<string, unknown[]> = {}) => {
    vi.stubGlobal(`fetch`, (url: URL | string) => {
        const target = String(url);
        const app = /\/apps\/([^/]+)\/machines$/.exec(target)?.[1];
        const body =
            app !== undefined
                ? (machines[app] ?? [])
                : target.endsWith('/volumes')
                  ? []
                  : { apps: apps.map((name) => ({ name })) };
        return Promise.resolve(new Response(JSON.stringify(body)));
    });
};

// Whose stamp a Fly machine carries and how old it is; two hours by default, outside the reaper's grace window.
const flyMachine = (platform: string, ageMinutes = 120) => ({
    id: `m1`,
    state: `stopped`,
    created_at: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    config: { metadata: { intentic_role: `sandbox`, intentic_platform: platform } },
});

// Counts mirror the same rows as the listings; pool count is asked twice (whole pool, then claimable).
const prismaWith = (machines: unknown[], pooled: unknown[]) =>
    ({
        hostedMachine: { findMany: vi.fn().mockResolvedValue(machines), count: vi.fn().mockResolvedValue(machines.length) },
        hostedPoolMachine: {
            findMany: vi.fn().mockResolvedValue(pooled),
            count: vi.fn().mockImplementation((args?: { where?: Record<string, unknown> }) =>
                Promise.resolve(
                    args?.where === undefined ? pooled.length : pooled.filter((row) => (row as { state?: string }).state === `ready`).length,
                ),
            ),
        },
        hostedBuild: { count: vi.fn().mockResolvedValue(0) },
    }) as unknown as PrismaClient;

const taken = (appName: string) => ({ appName, region: `iad`, wokeAt: null, sandboxId: `s1`, sandbox: { owner: { email: `o@test` } } });
const warm = (appName: string, region = `iad`) => ({ appName, region, state: `ready` });

afterEach(() => {
    vi.unstubAllGlobals();
    forgetHostedHealthAlert();
});

describe(`hosted health`, () => {
    it(`says nothing is wrong when every row has its machine and both pools are stocked`, async () => {
        stubApps(`intentic-sbx-a`, `intentic-sbx-pool-1`, `intentic-sbx-pool-2`);
        const prisma = prismaWith([taken(`intentic-sbx-a`)], [warm(`intentic-sbx-pool-1`), warm(`intentic-sbx-pool-2`, `arn`)]);
        const health = await sweepHostedHealth(prisma, config(), logger);
        expect(health).toMatchObject({ healthy: true, missing: [], strangers: [] });
    });

    it(`names the rows whose machine has vanished from the provider`, async () => {
        stubApps(`intentic-sbx-pool-1`);
        const prisma = prismaWith([taken(`intentic-sbx-a`), taken(`intentic-sbx-b`)], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.healthy).toBe(false);
        expect(health?.missing).toEqual([`intentic-sbx-a`, `intentic-sbx-b`]);
    });

    // Read off the provider's own stamp, never off a missing row.
    it(`names apps running another deployment's machines`, async () => {
        stubFly([`intentic-sbx-pool-1`, `intentic-sbx-someone-elses`], { "intentic-sbx-someone-elses": [flyMachine(`another-platform`)] });
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.strangers).toEqual([`intentic-sbx-someone-elses`]);
        expect(health?.litter).toEqual([]);
        expect(health?.healthy).toBe(false);
    });

    it(`treats an app with no row of its own as litter, not as a stranger, and stays healthy`, async () => {
        stubFly([`intentic-sbx-pool-1`, `intentic-sbx-leftover`]);
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.litter).toEqual([`intentic-sbx-leftover`]);
        expect(health?.strangers).toEqual([]);
        // healthy gates whether the alert mail fires.
        expect(health?.healthy).toBe(true);
    });

    it(`counts warm stock per region against the target, because a pool that never fills is a cold boot for everybody`, async () => {
        stubApps(`intentic-sbx-pool-1`);
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1 }), logger);
        expect(health?.stock).toEqual([
            { region: `iad`, warm: 1, target: 1 },
            { region: `arn`, warm: 0, target: 1 },
        ]);
        expect(health?.healthy).toBe(false);
    });

    // A full ceiling looks like ordinary low stock but isn't: no tick fixes it without a raised allowance.
    it(`is unhealthy, and says why, when the fleet has reached the ceiling`, async () => {
        stubApps(`intentic-sbx-a`);
        const prisma = prismaWith([taken(`intentic-sbx-a`)], []);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 0, regionEu: ``, maxMachines: 1 }), logger);
        expect(health?.capacity).toEqual({ used: 1, cap: 1, full: true, reason: `cap` });
        expect(health?.healthy).toBe(false);
    });

    it(`does nothing at all when the lane is off`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal(`fetch`, fetchSpy);
        expect(await sweepHostedHealth(prismaWith([], []), config({ flyApiToken: `` }), logger)).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
