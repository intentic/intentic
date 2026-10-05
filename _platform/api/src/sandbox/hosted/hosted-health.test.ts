import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { forgetHostedHealthAlert, sweepHostedHealth } from "./hosted-health.js";
import { forgetProviderCapacity, noteProviderAtCapacity } from "./hosted-capacity.js";
import { fakeHostedAppLock } from "../../testing.js";

jest.mock(`./hosted-app-lock.js`, () => ({ withHostedAppLock: fakeHostedAppLock }));

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

// The edge's own /health, as a CURRENT build answers it: a `build` key is what says something has rolled it. Every stub
// below answers it, because the sweep asks on every pass and a stub that stayed silent would fail each fleet test for
// the edge's reason rather than its own.
const EDGE_URL = `https://ingress.sbx.test/health`;
const EDGE_OK = { status: `ok`, tunnels: 0, instance: `m1`, peers: 1, remote: 0, build: `turbo-abc` };

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
// `stranded` is what the rows a failed rollback stamped answer (gate/state-gate.ts); none by default. `deleted` names the
// apps whose sandbox has a deletion record, which is what makes an app with no row litter rather than forgotten.
const prismaWith = (
    machines: unknown[],
    pooled: unknown[],
    reach: Reach = { reachable: 0, unreachable: 0 },
    stranded: unknown[] = [],
    deleted: string[] = [],
) => {
    const db = {
        sandbox: {
            count: jest
                .fn()
                .mockImplementation((args: { where: { bootReport: { equals: string } } }) =>
                    Promise.resolve(args.where.bootReport.equals === `reachable` ? reach.reachable : reach.unreachable),
                ),
            // Which orphan apps a sandbox row still names: none here.
            findMany: jest.fn().mockResolvedValue([]),
            // A repair clears the dropped machine's address.
            update: jest.fn().mockResolvedValue({}),
        },
        sandboxTombstone: { findMany: jest.fn().mockResolvedValue(deleted.map((app) => ({ tunnelId: app.slice(`intentic-sbx-`.length) }))) },
        hostedMachine: {
            findMany: jest
                .fn()
                .mockImplementation((args?: { where?: Record<string, unknown> }) =>
                    Promise.resolve(args?.where?.[`strandedAt`] === undefined ? machines : stranded),
                ),
            count: jest.fn().mockResolvedValue(machines.length),
            // The repair's re-read under the app's lock, and the meter's read as the row is dropped: as listed, never awake.
            findUnique: jest
                .fn()
                .mockImplementation((args: { where: { id: string } }) =>
                    Promise.resolve((machines as { id?: string }[]).find((row) => row.id === args.where.id) ?? null),
                ),
            delete: jest.fn().mockResolvedValue({}),
        },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => work(db)),
        hostedPoolMachine: {
            findMany: jest.fn().mockResolvedValue(pooled),
            count: jest
                .fn()
                .mockImplementation((args?: { where?: Record<string, unknown> }) =>
                    Promise.resolve(
                        args?.where === undefined ? pooled.length : pooled.filter((row) => (row as { state?: string }).state === `ready`).length,
                    ),
                ),
        },
        hostedBuild: { count: jest.fn().mockResolvedValue(0) },
    };
    return db as unknown as PrismaClient & typeof db;
};

// A person's machine row, as the fleet join and the repair both read it.
const taken = (appName: string, over: Record<string, unknown> = {}) => ({
    id: `h-${appName}`,
    appName,
    machineId: `m-${appName}`,
    region: `iad`,
    wokeAt: null,
    sandboxId: `s1`,
    migratingId: null,
    buildingId: null,
    sandbox: { ownerId: `u1`, owner: { email: `o@test` } },
    ...over,
});
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
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)], undefined, [], [`intentic-sbx-leftover`]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.litter).toEqual([`intentic-sbx-leftover`]);
        expect(health?.strangers).toEqual([]);
        // healthy gates whether the alert mail fires.
        expect(health?.healthy).toBe(true);
    });

    // Neither a row nor a deletion record: the reaper never destroys it, so the watch names it for an operator. Not
    // litter (it is not the reaper's work) and not a fault (a restore from an older backup leaves exactly these).
    it(`names an app no record explains as forgotten, apart from litter, and stays healthy`, async () => {
        stubFly([`intentic-sbx-pool-1`, `intentic-sbx-unexplained`]);
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.forgotten).toEqual([`intentic-sbx-unexplained`]);
        expect(health?.litter).toEqual([]);
        expect(health?.healthy).toBe(true);
    });

    /* A MACHINE ON NEITHER VERSION. The gate stamped its row when the rollback failed; until the sandbox checks in after
     * that stamp, the sweep names it, mails it, and says what the gate was doing. */
    it(`names and mails a machine a failed rollback stranded, until it checks in again`, async () => {
        const sent: string[] = [];
        stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
            const target = String(url);
            if (target.startsWith(`https://api.resend.com`)) {
                sent.push(String(init?.body ?? ``));
                return Promise.resolve(new Response(JSON.stringify({ id: `sent` })));
            }
            return Promise.resolve(
                edgeAnswer(target, EDGE_OK) ?? new Response(JSON.stringify({ apps: [{ name: `intentic-sbx-a` }, { name: `intentic-sbx-b` }] })),
            );
        });
        const strandedAt = new Date(Date.now() - 60_000);
        const detail = `moving ghcr.io/intentic/sandbox@sha256:aaa to ghcr.io/intentic/sandbox@sha256:bbb, putting the previous version back failed: boom`;
        const stranded = [
            { appName: `intentic-sbx-a`, strandedAt, strandedDetail: detail, sandbox: { lastSeenAt: new Date(strandedAt.getTime() - 60_000) } },
            // Checked in since: running again, whatever the stamp says.
            { appName: `intentic-sbx-b`, strandedAt, strandedDetail: detail, sandbox: { lastSeenAt: new Date() } },
        ];
        // SAFETY: the sweep reads only these fields of the config; the fixture's own, with mail switched on.
        const mailed: Config = {
            ...config({ poolSize: 0, regionEu: `` }),
            admin: { emails: `ops@test` },
            email: { apiKey: `k`, from: `i@test` },
        } as never;
        const prisma = prismaWith([taken(`intentic-sbx-a`), taken(`intentic-sbx-b`)], [], undefined, stranded);
        const health = await sweepHostedHealth(prisma, mailed, logger);
        expect(health?.stranded).toEqual([{ appName: `intentic-sbx-a`, detail }]);
        expect(health?.healthy).toBe(false);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain(`intentic-sbx-a (${detail})`);
        expect(sent[0]).not.toContain(`intentic-sbx-b`);
    });

    /* WHAT IT REPAIRS (2026-10-05). It used to mail about these every six hours and change nothing. */
    describe(`repairs`, () => {
        // Fly as these cases need it: the org's apps, and per path an answer; anything else answers the app list.
        const stubProvider = (apps: string[], answers: Record<string, () => Response>, mails: string[] = []) => {
            const calls: string[] = [];
            stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
                const target = String(url);
                calls.push(`${init?.method ?? `GET`} ${target}`);
                if (target.startsWith(`https://api.resend.com`)) {
                    mails.push(String(init?.body ?? ``));
                    return Promise.resolve(new Response(JSON.stringify({ id: `sent` })));
                }
                const edge = edgeAnswer(target, EDGE_OK);
                if (edge !== undefined) {
                    return Promise.resolve(edge);
                }
                const answer = Object.entries(answers).find(([path]) => target.endsWith(path))?.[1];
                return Promise.resolve(answer?.() ?? new Response(JSON.stringify({ apps: apps.map((name) => ({ name })) })));
            });
            return calls;
        };
        const gone = () => new Response(JSON.stringify({ error: `not found` }), { status: 404 });
        const machineAt = (state: string) => () => new Response(JSON.stringify({ id: `m`, state }));
        const quiet = config({ poolSize: 0, regionEu: `` });
        const mailing: Config = { ...quiet, admin: { emails: `ops@test` }, email: { apiKey: `k`, from: `i@test` } } as never;

        it(`drops a row whose app the provider answers 404 for, keeps the sandbox, and mails the lost disk once`, async () => {
            const mails: string[] = [];
            stubProvider([], { "/apps/intentic-sbx-a": gone }, mails);
            const prisma = prismaWith([taken(`intentic-sbx-a`)], []);
            const health = await sweepHostedHealth(prisma, mailing, logger);
            expect(health?.repaired.appGone).toEqual([`intentic-sbx-a`]);
            expect(health?.missing).toEqual([]);
            expect(prisma.hostedMachine.delete).toHaveBeenCalledWith({ where: { id: `h-intentic-sbx-a` } });
            // The sandbox stays, with its dead address cleared so its owner is offered a new machine.
            expect(prisma.sandbox.update).toHaveBeenCalledWith({ where: { id: `s1` }, data: { daemonUrl: null } });
            expect(health?.healthy).toBe(false);
            expect(mails).toHaveLength(1);
            expect(mails[0]).toContain(`intentic-sbx-a`);
        });

        it(`keeps a row whose app the listing merely left out, while the app itself still answers`, async () => {
            stubProvider([], { "/apps/intentic-sbx-a": () => new Response(JSON.stringify({ name: `intentic-sbx-a` })) });
            const prisma = prismaWith([taken(`intentic-sbx-a`)], []);
            const health = await sweepHostedHealth(prisma, quiet, logger);
            expect(health?.repaired.appGone).toEqual([]);
            expect(health?.missing).toEqual([`intentic-sbx-a`]);
            expect(prisma.hostedMachine.delete).not.toHaveBeenCalled();
        });

        // Invisible to the fleet check, which reads apps: only the machine's own 404 says it.
        it(`drops a row whose machine is gone inside an app that still stands, keeping the app for adoption`, async () => {
            const calls = stubProvider([`intentic-sbx-a`], {
                "/apps/intentic-sbx-a/machines/m-intentic-sbx-a": gone,
                "/apps/intentic-sbx-a": () => new Response(JSON.stringify({ name: `intentic-sbx-a` })),
            });
            const prisma = prismaWith([taken(`intentic-sbx-a`)], []);
            const health = await sweepHostedHealth(prisma, quiet, logger);
            expect(health?.repaired).toEqual({ appGone: [], machineGone: [`intentic-sbx-a`] });
            expect(prisma.hostedMachine.delete).toHaveBeenCalledWith({ where: { id: `h-intentic-sbx-a` } });
            expect(calls.some((call) => call.startsWith(`DELETE`))).toBe(false);
            // The disk is still there for the sandbox's next start: nothing to mail.
            expect(health?.healthy).toBe(true);
        });

        it(`leaves a row alone when the provider answers for its machine, or fails to answer at all`, async () => {
            stubProvider([`intentic-sbx-a`, `intentic-sbx-b`], {
                "/apps/intentic-sbx-a/machines/m-intentic-sbx-a": machineAt(`stopped`),
                "/apps/intentic-sbx-b/machines/m-intentic-sbx-b": () => new Response(`{"error":"internal"}`, { status: 500 }),
            });
            const prisma = prismaWith([taken(`intentic-sbx-a`), taken(`intentic-sbx-b`)], []);
            const health = await sweepHostedHealth(prisma, quiet, logger);
            expect(health?.repaired).toEqual({ appGone: [], machineGone: [] });
            expect(prisma.hostedMachine.delete).not.toHaveBeenCalled();
        });

        it(`does not read a machine mid-change: a build or a move holds it`, async () => {
            const calls = stubProvider([`intentic-sbx-a`], { "/apps/intentic-sbx-a/machines/m-intentic-sbx-a": gone });
            const prisma = prismaWith([taken(`intentic-sbx-a`, { buildingId: `b1` })], []);
            const health = await sweepHostedHealth(prisma, quiet, logger);
            expect(health?.repaired.machineGone).toEqual([]);
            expect(calls.some((call) => call.includes(`/machines/`))).toBe(false);
        });
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

    /* THE STALE EDGE A PERFECT FLEET WOULD OTHERWISE HIDE. */
    it(`is unhealthy on a perfect fleet when the edge carries no build stamp, so its machines never rolled`, async () => {
        const { status, tunnels } = EDGE_OK;
        stubFly([`intentic-sbx-a`, `intentic-sbx-pool-1`], {}, { status, tunnels });
        const prisma = prismaWith([taken(`intentic-sbx-a`)], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.missing).toEqual([]);
        expect(health?.strangers).toEqual([]);
        expect(health?.edge?.stamped).toBe(false);
        expect(health?.edge?.fault).toContain(`OLD BUILD`);
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

    // The edge replays nothing any more, so a `replay` it still reports (a build from before that went) decides nothing.
    it(`reads a stamped edge as healthy whatever it says about replay`, async () => {
        stubFly([`intentic-sbx-pool-1`], {}, { ...EDGE_OK, replay: false });
        const prisma = prismaWith([], [warm(`intentic-sbx-pool-1`)]);
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.edge).toEqual({ build: `turbo-abc`, stamped: true, reached: true, fault: undefined });
        expect(health?.healthy).toBe(true);
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

    /* A DEPLOY RELAUNCHES THE EDGE FOR SECONDS. One tick landing in that gap is reported but not mailed; the next tick
     * missing it too is an outage, and mails. */
    it(`mails an unreachable edge only once a second tick in a row cannot reach it either`, async () => {
        // The regional-refusal test above latches arn; left standing it would mail this fleet as full.
        forgetProviderCapacity();
        const sent: string[] = [];
        let edgeUp = false;
        stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
            const target = String(url);
            if (target.startsWith(`https://api.resend.com`)) {
                sent.push(String(init?.body ?? ``));
                return Promise.resolve(new Response(JSON.stringify({ id: `sent` })));
            }
            if (target === EDGE_URL) {
                return edgeUp ? Promise.resolve(new Response(JSON.stringify(EDGE_OK))) : Promise.reject(new Error(`ECONNREFUSED`));
            }
            return Promise.resolve(new Response(JSON.stringify({ apps: [] })));
        });
        const mailed = {
            ...config({ poolSize: 0, regionEu: `` }),
            admin: { emails: `ops@test` },
            email: { apiKey: `k`, from: `i@test` },
        } as unknown as Config;
        const prisma = prismaWith([], []);

        const blip = await sweepHostedHealth(prisma, mailed, logger);
        expect(blip?.edge?.fault).toContain(`could not be reached at all`);
        expect(blip?.healthy).toBe(false);
        expect(sent).toHaveLength(0);

        // The edge came back: the miss is forgotten, so the next lone miss is a blip again.
        edgeUp = true;
        expect((await sweepHostedHealth(prisma, mailed, logger))?.healthy).toBe(true);
        edgeUp = false;
        await sweepHostedHealth(prisma, mailed, logger);
        expect(sent).toHaveLength(0);

        // Still down a tick later: that is an outage.
        await sweepHostedHealth(prisma, mailed, logger);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain(`could not be reached at all`);
    });

    /* THE OUTAGE EVERY OTHER READING HERE CALLS HEALTHY. */
    it(`is unhealthy when every sandbox that checked in says its own address does not answer`, async () => {
        stubFly([`intentic-sbx-a`, `intentic-sbx-pool-1`]);
        const prisma = prismaWith([taken(`intentic-sbx-a`)], [warm(`intentic-sbx-pool-1`)], { reachable: 0, unreachable: 3 });
        const health = await sweepHostedHealth(prisma, config({ poolSize: 1, regionEu: `` }), logger);
        expect(health?.edge?.fault).toBeUndefined();
        expect(health?.missing).toEqual([]);
        expect(health?.lane).toMatchObject({ reachable: 0, unreachable: 3 });
        expect(health?.lane.fault).toContain(`tunnel registered`);
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
