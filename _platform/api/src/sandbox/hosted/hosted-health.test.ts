import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { forgetHostedHealthAlert, sweepHostedHealth } from "./hosted-health.js";
import { forgetProviderCapacity, noteProviderAtCapacity } from "./hosted-capacity.js";

// Every other sweep here acts on the gap between the platform's rows and Fly, but never reported the gap itself. These
// tests pin what this watch has to say out loud.

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;

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

const edgeAnswer = (target: string, edge: unknown): Response | undefined => (target === EDGE_URL ? new Response(JSON.stringify(edge)) : undefined);

const stubApps = (...names: string[]) => {
    stubGlobal(`fetch`, (url: URL | string) =>
        Promise.resolve(edgeAnswer(String(url), EDGE_OK) ?? new Response(JSON.stringify({ apps: names.map((name) => ({ name })) }))),
    );
};

// The org's app list and what each app runs, since ownership is now read off the provider, not a missing row.
// `edge` is what the edge answers, so a test can hand back an old build without touching the Fly half.
const stubFly = (apps: string[], machines: Record<string, unknown[]> = {}, edge: unknown = EDGE_OK) => {
    stubGlobal(`fetch`, (url: URL | string) => {
        const target = String(url);
        const edgeResponse = edgeAnswer(target, edge);
        if (edgeResponse !== undefined) {
            return Promise.resolve(edgeResponse);
        }
        const app = /\/apps\/([^/]+)\/machines$/.exec(target)?.[1];
        const body = app !== undefined ? (machines[app] ?? []) : target.endsWith("/volumes") ? [] : { apps: apps.map((name) => ({ name })) };
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

// What the daemons last said about their own addresses; zero of each is a platform nobody has booted on today.
type Reach = { reachable: number; unreachable: number };

// Counts mirror the same rows as the listings; pool count is asked twice (whole pool, then claimable).
const prismaWith = (machines: unknown[], pooled: unknown[], reach: Reach = { reachable: 0, unreachable: 0 }) =>
    ({
        sandbox: {
            count: jest.fn().mockImplementation((args: { where: { bootReport: { equals: string } } }) =>
                Promise.resolve(args.where.bootReport.equals === `reachable` ? reach.reachable : reach.unreachable),
            ),
        },
        hostedMachine: { findMany: jest.fn().mockResolvedValue(machines), count: jest.fn().mockResolvedValue(machines.length) },
        hostedPoolMachine: {
            findMany: jest.fn().mockResolvedValue(pooled),
            count: jest.fn().mockImplementation((args?: { where?: Record<string, unknown> }) =>
                Promise.resolve(
                    args?.where === undefined ? pooled.length : pooled.filter((row) => (row as { state?: string }).state === `ready`).length,
                ),
            ),
        },
        hostedBuild: { count: jest.fn().mockResolvedValue(0) },
    }) as unknown as PrismaClient;

const taken = (appName: string) => ({ appName, region: `iad`, wokeAt: null, sandboxId: `s1`, sandbox: { owner: { email: `o@test` } } });
const warm = (appName: string, region = `iad`) => ({ appName, region, state: `ready` });

afterEach(() => {
    unstubAllGlobals();
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
        expect(health?.capacity).toEqual({ used: 1, cap: 1, full: true, reason: `cap`, refusals: [] });
        expect(health?.healthy).toBe(false);
    });

    /* Regional refusals name the region and preserve healthy regions. */
    it(`names the refusing region, quotes the provider, and does not call the lane down for one region's refusal`, async () => {
        const sent: string[] = [];
        stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
            const target = String(url);
            if (target.startsWith(`https://api.resend.com`)) {
                sent.push(String(init?.body ?? ``));
                return Promise.resolve(new Response(JSON.stringify({ id: `sent` })));
            }
            return Promise.resolve(edgeAnswer(target, EDGE_OK) ?? new Response(JSON.stringify({ apps: [{ name: `intentic-sbx-a` }] })));
        });
        forgetProviderCapacity();
        noteProviderAtCapacity(`arn`, `Fly refused POST /apps/intentic-sbx-b/volumes: insufficient capacity to create volume`);
        const mailed = { ...config({ poolSize: 0 }), admin: { emails: `ops@test` }, email: { apiKey: `k`, from: `i@test` } } as unknown as Config;
        const health = await sweepHostedHealth(prismaWith([taken(`intentic-sbx-a`)], []), mailed, logger);
        expect(health?.capacity).toMatchObject({ full: true, reason: `provider`, refusals: [{ region: `arn` }] });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain(`insufficient capacity to create volume`);
        // The scope, in the words a reader acts on: arn is refused, iad is not, and neither is asserted of the other.
        expect(sent[0]).toContain(`Only sign-ups placed in arn are refused`);
        expect(sent[0]).not.toContain(`no sign-up anywhere`);
    });

    /* A fully stocked fleet is unhealthy when its edge lacks replay support. */
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

    /* THE STALE EDGE THE TWO CHECKS AROUND IT BOTH LET THROUGH. */
    it(`is unhealthy when the edge replays but carries no build stamp, so its machines never rolled`, async () => {
        const { status, tunnels, replay } = EDGE_OK;
        stubFly([`intentic-sbx-pool-1`], {}, { status, tunnels, replay });
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.edge?.replay).toBe(true);
        expect(health?.edge?.stamped).toBe(false);
        expect(health?.edge?.fault).toContain(`no build stamp`);
        expect(health?.healthy).toBe(false);
    });

    // An image nobody released names itself with an empty string, which is a self-built edge rather than a
    // stale one: the key is there, so nothing here is stale, and the lane stays healthy.
    it(`leaves an unreleased edge alone, since carrying the key is the age test`, async () => {
        stubFly([`intentic-sbx-pool-1`], {}, { ...EDGE_OK, build: `` });
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.edge?.stamped).toBe(true);
        expect(health?.edge?.build).toBeUndefined();
        expect(health?.edge?.fault).toBeUndefined();
        expect(health?.healthy).toBe(true);
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
        stubGlobal(`fetch`, (url: URL | string) =>
            String(url) === EDGE_URL
                ? Promise.reject(new Error(`getaddrinfo ENOTFOUND`))
                : Promise.resolve(new Response(JSON.stringify({ apps: [] }))),
        );
        const health = await sweepHostedHealth(prismaWith([], []), config({ poolSize: 0, regionEu: `` }), logger);
        expect(health?.edge?.fault).toContain(`could not be reached at all`);
        expect(health?.healthy).toBe(false);
    });

    /* THE OUTAGE EVERY OTHER READING HERE CALLS HEALTHY. */
    it(`is unhealthy when every sandbox that checked in says its own address does not answer`, async () => {
        stubFly([`intentic-sbx-a`, `intentic-sbx-pool-1`]);
        const prisma = prismaWith([taken(`intentic-sbx-a`)], [warm(`intentic-sbx-pool-1`)], { reachable: 0, unreachable: 3 });
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.edge?.fault).toBeUndefined();
        expect(health?.missing).toEqual([]);
        expect(health?.lane).toMatchObject({ reachable: 0, unreachable: 3 });
        expect(health?.lane.fault).toContain(`cross-network-replays`);
        expect(health?.healthy).toBe(false);
    });

    // One box failing on its own is not a lane verdict; the admin panel lists it, nobody is woken for it.
    it(`keeps quiet about the lane when a single sandbox is the only one failing`, async () => {
        stubFly([`intentic-sbx-a`, `intentic-sbx-pool-1`]);
        const prisma = prismaWith([taken(`intentic-sbx-a`)], [warm(`intentic-sbx-pool-1`)], { reachable: 0, unreachable: 1 });
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.lane.fault).toBeUndefined();
        expect(health?.healthy).toBe(true);
    });

    // One sandbox getting through proves the lane delivers; the rest are their own faults, not the fabric's.
    it(`keeps quiet about the lane while anybody at all is getting through`, async () => {
        stubFly([`intentic-sbx-a`, `intentic-sbx-pool-1`]);
        const prisma = prismaWith([taken(`intentic-sbx-a`)], [warm(`intentic-sbx-pool-1`)], { reachable: 1, unreachable: 4 });
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.lane.fault).toBeUndefined();
        expect(health?.healthy).toBe(true);
    });

    // No ingress means no hosted lane at all (hostedEnabled → ingressEnabled), so there is no edge to ask and
    // nothing to alarm about. Pinned because the edge probe must never fire on a platform that has no edge.
    it(`asks no edge when the platform has no ingress configured`, async () => {
        const fetchSpy = jest.fn();
        stubGlobal(`fetch`, fetchSpy);
        const noIngress = { ...config({ poolSize: 1, regionEu: `` }), ingress: { url: ``, signingKey: ``, zone: `` } } as never;
        expect(await sweepHostedHealth(prismaWith([], []), noIngress, logger)).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`does nothing at all when the lane is off`, async () => {
        const fetchSpy = jest.fn();
        stubGlobal(`fetch`, fetchSpy);
        expect(await sweepHostedHealth(prismaWith([], []), config({ flyApiToken: `` }), logger)).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
