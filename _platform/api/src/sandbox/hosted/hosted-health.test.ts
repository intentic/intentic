import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../../config.js";
import { forgetHostedHealthAlert, sweepHostedHealth } from "./hosted-health.js";

/* THE WATCH THAT WAS MISSING. Every other sweep in this directory ACTS on the gap between the platform's rows
 * and Fly; none of them ever reported the gap itself, so a fleet destroyed under its rows was visible only as
 * one warn line per machine per night, and the first person to notice was a user pressing a button that could
 * not work. These tests pin the three things it has to say out loud. */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const config = (over: Record<string, unknown> = {}): Config =>
    ({
        webOrigin: `https://app.test`,
        api: { url: `https://api.test` },
        admin: { emails: `` },
        email: { apiKey: ``, from: `` },
        zrok: { apiEndpoint: `https://zrok2.sbx.test`, adminToken: `hub-admin` },
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

const prismaWith = (machines: unknown[], pooled: unknown[]) =>
    ({
        hostedMachine: { findMany: vi.fn().mockResolvedValue(machines) },
        hostedPoolMachine: { findMany: vi.fn().mockResolvedValue(pooled) },
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

    /* THE OUTAGE'S OWN SIGNATURE, and the reading this whole module exists for: rows that believe in machines
     * Fly does not have. One is a hiccup; several at once is another deployment's reaper eating this fleet. */
    it(`names the rows whose machine has vanished from the provider`, async () => {
        stubApps(`intentic-sbx-pool-1`);
        const prisma = prismaWith([taken(`intentic-sbx-a`), taken(`intentic-sbx-b`)], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.healthy).toBe(false);
        expect(health?.missing).toEqual([`intentic-sbx-a`, `intentic-sbx-b`]);
    });

    // The CAUSE rather than the symptom, and the one this catches before anybody's machine is lost: apps under
    // our prefix that this platform did not make.
    it(`names our-prefix apps this platform has no row for at all`, async () => {
        stubApps(`intentic-sbx-pool-1`, `intentic-sbx-someone-elses`);
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.strangers).toEqual([`intentic-sbx-someone-elses`]);
        expect(health?.healthy).toBe(false);
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

    it(`does nothing at all when the lane is off`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal(`fetch`, fetchSpy);
        expect(await sweepHostedHealth(prismaWith([], []), config({ flyApiToken: `` }), logger)).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
