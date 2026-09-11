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

// The edge's own /health, as a CURRENT build answers it: `replay` present and true is what says this edge can
// route a hosted sandbox at all. Every stub below answers it, because the sweep asks on every pass and a stub
// that stayed silent would fail each fleet test for the edge's reason rather than its own.
const EDGE_URL = `https://ingress.sbx.test/health`;
const EDGE_OK = { status: `ok`, tunnels: 0, instance: `m1`, peers: 1, remote: 0, replay: true, build: `turbo-abc` };

const edgeAnswer = (target: string, edge: unknown): Response | undefined =>
    target === EDGE_URL ? new Response(JSON.stringify(edge)) : undefined;

const stubApps = (...names: string[]) => {
    vi.stubGlobal(`fetch`, (url: URL | string) =>
        Promise.resolve(edgeAnswer(String(url), EDGE_OK) ?? new Response(JSON.stringify({ apps: names.map((name) => ({ name })) }))),
    );
};

// The org's app list and what each app runs, since ownership is now read off the provider, not a missing row.
// `edge` is what the edge answers, so a test can hand back an old build without touching the Fly half.
const stubFly = (apps: string[], machines: Record<string, unknown[]> = {}, edge: unknown = EDGE_OK) => {
    vi.stubGlobal(`fetch`, (url: URL | string) => {
        const target = String(url);
        const edgeResponse = edgeAnswer(target, edge);
        if (edgeResponse !== undefined) {
            return Promise.resolve(edgeResponse);
        }
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

    /* THE OUTAGE THIS WATCH WAS MISSING, and the shape of it is the whole point: every row has its machine,
     * both pools are stocked, the fleet and the database agree completely — and not one hosted sandbox can be
     * reached, because the process in front of them is a build from before the replay lane existed. The sweep
     * used to call this healthy, and did for ten days while people were told to start their sandboxes over. */
    it(`is unhealthy on a perfect fleet when the edge is an old build with no replay lane`, async () => {
        const { status, tunnels } = EDGE_OK;
        // Exactly what the pre-replay edge answered: no `replay` key at all, so absence is the only signal.
        stubFly([`intentic-sbx-a`, `intentic-sbx-pool-1`], {}, { status, tunnels });
        const prisma = prismaWith([taken(`intentic-sbx-a`)], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.missing).toEqual([]);
        expect(health?.strangers).toEqual([]);
        expect(health?.edge?.replay).toBeUndefined();
        expect(health?.edge?.fault).toContain(`OLD BUILD`);
        expect(health?.healthy).toBe(false);
    });

    // Told apart from the old build above because the remedy differs: one variable, not a deploy.
    it(`is unhealthy, and blames the prefix, when the edge runs with replay switched off`, async () => {
        stubFly([`intentic-sbx-pool-1`], {}, { ...EDGE_OK, replay: false });
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.edge?.replay).toBe(false);
        expect(health?.edge?.fault).toContain(`HOSTED_APP_PREFIX`);
        expect(health?.healthy).toBe(false);
    });

    // The edge unreachable means nothing is reachable, tunnel lane included; it must not read as a fleet fault.
    it(`says so when the edge cannot be reached at all`, async () => {
        vi.stubGlobal(`fetch`, (url: URL | string) =>
            String(url) === EDGE_URL ? Promise.reject(new Error(`getaddrinfo ENOTFOUND`)) : Promise.resolve(new Response(JSON.stringify({ apps: [] }))),
        );
        const health = await sweepHostedHealth(prismaWith([], []), config({ poolSize: 0, regionEu: `` }), logger);
        expect(health?.edge?.fault).toContain(`could not be reached at all`);
        expect(health?.healthy).toBe(false);
    });

    // No ingress means no hosted lane at all (hostedEnabled → ingressEnabled), so there is no edge to ask and
    // nothing to alarm about. Pinned because the edge probe must never fire on a platform that has no edge.
    it(`asks no edge when the platform has no ingress configured`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal(`fetch`, fetchSpy);
        const noIngress = { ...config({ poolSize: 1, regionEu: `` }), ingress: { url: ``, signingKey: ``, zone: `` } } as never;
        expect(await sweepHostedHealth(prismaWith([], []), noIngress, logger)).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`does nothing at all when the lane is off`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal(`fetch`, fetchSpy);
        expect(await sweepHostedHealth(prismaWith([], []), config({ flyApiToken: `` }), logger)).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
