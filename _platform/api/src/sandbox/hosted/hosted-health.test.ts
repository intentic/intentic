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

/* The org's app list AND what each app is running, because "whose app is this" is now asked of the provider
 * rather than inferred from the absence of a row. An app not named in `machines` is running none, which is a
 * verdict of its own (see the litter test below). */
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

// A Fly machine as the classifier reads it: whose stamp it carries, and how old it is. Two hours by default,
// so nothing here is inside the reaper's grace window by accident.
const flyMachine = (platform: string, ageMinutes = 120) => ({
    id: `m1`,
    state: `stopped`,
    created_at: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    config: { metadata: { intentic_role: `sandbox`, intentic_platform: platform } },
});

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

    /* The CAUSE rather than the symptom, and the one this catches before anybody's machine is lost: an app
     * under our prefix running a machine that names a DIFFERENT deployment. Read off the provider's own stamp,
     * never off the absence of a row. */
    it(`names apps running another deployment's machines`, async () => {
        stubFly([`intentic-sbx-pool-1`, `intentic-sbx-someone-elses`], { "intentic-sbx-someone-elses": [flyMachine(`another-platform`)] });
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.strangers).toEqual([`intentic-sbx-someone-elses`]);
        expect(health?.litter).toEqual([]);
        expect(health?.healthy).toBe(false);
    });

    /* AND THE ALARM THAT MUST NOT FIRE, which is what stopped this watch being read. An app with no row is
     * ordinary weather — a provision that failed and left its app behind — and the daily reaper collects it.
     * Counting it as a stranger mailed the admins "another deployment is sharing this Fly org", which was not
     * true, every six hours, about a fault no action could clear. It is reported and it is not an alarm. */
    it(`treats an app with no row of its own as litter, not as a stranger, and stays healthy`, async () => {
        stubFly([`intentic-sbx-pool-1`, `intentic-sbx-leftover`]);
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.litter).toEqual([`intentic-sbx-leftover`]);
        expect(health?.strangers).toEqual([]);
        // Healthy is the gate the alert mail sits behind, so this is the assertion that says "nobody is woken".
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

    it(`does nothing at all when the lane is off`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal(`fetch`, fetchSpy);
        expect(await sweepHostedHealth(prismaWith([], []), config({ flyApiToken: `` }), logger)).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
