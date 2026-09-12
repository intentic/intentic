import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { reconcileHostedPool } from "./hosted-pool.js";
import { hostedInstanceId } from "./hosted.js";

// Pins the pool's promises: warm machines never boot the sandbox, stock converges on the target per region, a drifted
// image is rebuilt, and switching the pool off empties it rather than stranding it behind the reaper.

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const config = (over?: Partial<Config[`hosted`]>): Config =>
    ({
        webOrigin: `https://app.test`,
        google: { clientId: `gcid` },
        api: { url: `https://api.test` },
        secrets: { key: `` },
        ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
        hosted: {
            flyApiToken: `fly`,
            flyOrg: `intentic`,
            region: `iad`,
            regionEu: `arn`,
            appPrefix: `intentic-sbx`,
            image: `ghcr.io/intentic/sandbox:stable`,
            cpus: 2,
            memoryMb: 4096,
            volumeGb: 10,
            perUser: 1,
            idleStopMinutes: 20,
            monthlyHours: 40,
            idleDays: 21,
            idleWarnDays: 14,
            poolSize: 1,
            // The schema's own default: no ceiling, so the refill's room is unlimited unless a case says otherwise.
            maxMachines: 0,
            ...over,
        },
    }) as unknown as Config;

// Fresh stamps by default; named as the build names it (secrets.key empty, so the token is plaintext).
const POOL_TOKEN = `p00l-t0k3n`;
const poolRow = (over?: Record<string, unknown>) => ({
    id: `p1`,
    appName: `intentic-sbx-${sandboxIdFromToken(POOL_TOKEN)}`,
    machineId: `m1`,
    volumeId: `vol_1`,
    region: `iad`,
    image: `ghcr.io/intentic/sandbox:stable`,
    state: `ready`,
    token: POOL_TOKEN,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
});

// Counts exist for the refill's room-left check (hosted-capacity.ts); only read on a platform with a ceiling.
const fakePrisma = (overrides?: Record<string, Record<string, ReturnType<typeof vi.fn>>>) =>
    ({
        hostedPoolMachine: {
            findMany: vi.fn().mockResolvedValue([]),
            count: vi.fn().mockResolvedValue(0),
            create: vi.fn().mockResolvedValue({}),
            update: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
            ...overrides?.[`hostedPoolMachine`],
        },
        hostedMachine: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0), ...overrides?.[`hostedMachine`] },
        hostedBuild: { count: vi.fn().mockResolvedValue(0), ...overrides?.[`hostedBuild`] },
    }) as never;

const stubFetch = (routes: { match: (method: string, url: string) => boolean; respond: () => Response }[]) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? `GET`;
        calls.push({ method, url: String(url), ...(typeof init?.body === `string` ? { body: JSON.parse(init.body) } : {}) });
        const route = routes.find((candidate) => candidate.match(method, String(url)));
        if (!route) {
            throw new Error(`unexpected fetch: ${method} ${String(url)}`);
        }
        return Promise.resolve(route.respond());
    });
    return calls;
};

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

const builderRoutes = [
    { match: (method: string, url: string) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
    { match: (method: string, url: string) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_9` }) },
    { match: (method: string, url: string) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m9`, state: `created` }) },
    { match: (method: string) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
];

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`reconcileHostedPool`, () => {
    it(`builds toward the target in BOTH regions, and the warm boot is the daemon's prewarm over the real image`, async () => {
        const create = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        await reconcileHostedPool(fakePrisma({ hostedPoolMachine: { create } }), config(), logger);
        const machines = calls.filter((entry) => entry.method === `POST` && entry.url.includes(`/machines`));
        expect(machines).toHaveLength(2);
        const regions = machines.map((entry) => (entry.body as { region: string }).region).toSorted();
        expect(regions).toEqual([`arn`, `iad`]);
        // Prewarm mode: the sandbox boots its own entrypoint (no exec override) with no identity at all.
        const posted = machines[0]?.body as {
            config: { image: string; init?: unknown; env: Record<string, string>; metadata: Record<string, string> };
        };
        expect(posted.config.image).toBe(`ghcr.io/intentic/sandbox:stable`);
        expect(posted.config.init).toBeUndefined();
        expect(posted.config.env[`SANDBOX_PREWARM`]).toBe(`1`);
        expect(posted.config.env[`SANDBOX_VM`]).toBe(`1`);
        // The app stays named `pool` for life and stamped from birth, so no other deployment reads this stock as
        // litter.
        expect(posted.config.metadata).toEqual({ intentic_role: `warm`, intentic_platform: hostedInstanceId(config()) });
        expect(posted.config.env[`CONNECT_TOKEN`]).toBeUndefined();
        expect(posted.config.env[`OWNER_EMAIL`]).toBeUndefined();
        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls[0]?.[0]).toMatchObject({ data: { state: `building`, image: `ghcr.io/intentic/sandbox:stable` } });
    });

    it(`builds nothing once the fleet is at the ceiling the provider allows`, async () => {
        const create = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        const prisma = fakePrisma({
            hostedPoolMachine: { create, count: vi.fn().mockResolvedValue(4) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(96) },
        });
        await reconcileHostedPool(prisma, config({ maxMachines: 100 }), logger);
        expect(calls.filter((entry) => entry.method === `POST` && entry.url.includes(`/machines`))).toHaveLength(0);
        expect(create).not.toHaveBeenCalled();
    });

    it(`builds up to the room the ceiling leaves`, async () => {
        const create = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        const prisma = fakePrisma({
            hostedPoolMachine: { create, count: vi.fn().mockResolvedValue(0) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(96) },
        });
        await reconcileHostedPool(prisma, config({ maxMachines: 100 }), logger);
        expect(calls.filter((entry) => entry.method === `POST` && entry.url.includes(`/machines`))).toHaveLength(2);
    });

    // The edge replays to `<prefix>-<id>` with no lookup; a pool app named otherwise couldn't serve a later claim.
    it(`names each warm app after a connect token it mints, and keeps that token in the row, not the machine`, async () => {
        const create = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        await reconcileHostedPool(fakePrisma({ hostedPoolMachine: { create } }), config({ regionEu: `` }), logger);
        const app = calls.find((entry) => entry.method === `POST` && entry.url.endsWith(`/apps`))?.body as { app_name: string };
        const row = create.mock.calls[0]?.[0] as { data: { appName: string; token: string } };
        expect(row.data.token).not.toBe(``);
        expect(row.data.appName).toBe(`intentic-sbx-${sandboxIdFromToken(row.data.token)}`);
        expect(app.app_name).toBe(row.data.appName);
        const machine = calls.find((entry) => entry.method === `POST` && entry.url.includes(`/machines`))?.body as {
            config: { env: Record<string, string> };
        };
        expect(machine.config.env[`CONNECT_TOKEN`]).toBeUndefined();
    });

    it(`replaces standing stock that carries no identity`, async () => {
        const deleteRow = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ id: `m1`, state: `stopped` }) },
            ...builderRoutes,
        ]);
        await reconcileHostedPool(
            fakePrisma({ hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow({ token: `` })]), delete: deleteRow } }),
            config({ regionEu: `` }),
            logger,
        );
        expect(deleteRow).toHaveBeenCalledWith({ where: { id: `p1` } });
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.endsWith(`/apps/${poolRow().appName}?force=true`))).toBe(true);
    });

    it(`flips a build to ready once its prewarm boot is observed stopped`, async () => {
        const update = vi.fn().mockResolvedValue({});
        stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ id: `m1`, state: `stopped` }) },
            ...builderRoutes,
        ]);
        const prisma = fakePrisma({
            hostedPoolMachine: {
                findMany: vi
                    .fn()
                    .mockResolvedValue([poolRow({ state: `building` }), poolRow({ id: `p2`, appName: `intentic-sbx-pool-arn`, region: `arn` })]),
                update,
            },
        });
        await reconcileHostedPool(prisma, config(), logger);
        expect(update).toHaveBeenCalledWith({ where: { id: `p1` }, data: { state: `ready` } });
    });

    // Claims take the oldest row first, so a phantom `ready` row would be handed out before any live machine.
    it(`replaces standing stock Fly no longer has: a ready row is a claim about a machine, not proof of one`, async () => {
        const del = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ error: `machine not found` }, 404) },
            ...builderRoutes,
        ]);
        const prisma = fakePrisma({ hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow()]), delete: del } });
        await reconcileHostedPool(prisma, config({ regionEu: `` }), logger);
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(poolRow().appName))).toBe(true);
        expect(del).toHaveBeenCalledWith({ where: { id: `p1` } });
        // The freed slot is refilled in the same pass.
        expect(calls.filter((entry) => entry.method === `POST` && entry.url.includes(`/machines`))).toHaveLength(1);
    });

    // Tearing down a late-noticed build would pay for the same pull twice.
    it(`banks a build that finished while nobody was watching, however late it is noticed`, async () => {
        const update = vi.fn().mockResolvedValue({});
        const del = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ id: `m1`, state: `stopped` }) },
            ...builderRoutes,
        ]);
        const stale = new Date(Date.now() - 60 * 60 * 1000);
        const prisma = fakePrisma({
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow({ state: `building`, createdAt: stale })]), update, delete: del },
        });
        await reconcileHostedPool(prisma, config({ regionEu: `` }), logger);
        expect(update).toHaveBeenCalledWith({ where: { id: `p1` }, data: { state: `ready` } });
        expect(del).not.toHaveBeenCalled();
        expect(calls.some((entry) => entry.method === `POST` && entry.url.includes(`/machines`))).toBe(false);
    });

    it(`keeps standing stock when Fly cannot be asked, and while a machine is mid-transition`, async () => {
        for (const respond of [() => json({ error: `internal` }, 500), () => json({ id: `m1`, state: `started` })]) {
            const del = vi.fn().mockResolvedValue({});
            const calls = stubFetch([{ match: (method, url) => method === `GET` && url.includes(`/machines/`), respond }, ...builderRoutes]);
            const prisma = fakePrisma({ hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow()]), delete: del } });
            // oxlint-disable-next-line eslint/no-await-in-loop -- two readings of the same row, one at a time
            await reconcileHostedPool(prisma, config({ regionEu: `` }), logger);
            expect(del).not.toHaveBeenCalled();
            expect(calls.some((entry) => entry.method === `DELETE`)).toBe(false);
            // Still counted as stock, so the target is already met.
            expect(calls.some((entry) => entry.method === `POST` && entry.url.includes(`/machines`))).toBe(false);
        }
    });

    it(`replaces a machine whose image drifted from config: its warm rootfs is the wrong rootfs`, async () => {
        const del = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        const prisma = fakePrisma({
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow({ image: `ghcr.io/intentic/sandbox:old` })]), delete: del },
        });
        await reconcileHostedPool(prisma, config({ regionEu: `` }), logger);
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(poolRow().appName))).toBe(true);
        expect(del).toHaveBeenCalledWith({ where: { id: `p1` } });
        // The freed slot is refilled in the same pass.
        expect(calls.filter((entry) => entry.method === `POST` && entry.url.includes(`/machines`))).toHaveLength(1);
    });

    it(`drains the whole pool when it is switched off: nothing in it is ever somebody's`, async () => {
        const del = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        const prisma = fakePrisma({
            hostedPoolMachine: {
                findMany: vi.fn().mockResolvedValue([poolRow(), poolRow({ id: `p2`, appName: `intentic-sbx-pool-two` })]),
                delete: del,
            },
        });
        await reconcileHostedPool(prisma, config({ poolSize: 0 }), logger);
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(2);
        expect(del).toHaveBeenCalledTimes(2);
        expect(calls.some((entry) => entry.method === `POST`)).toBe(false);
    });

    // A crashed claim's app may already carry a sandbox's tokens, so adopted vs. unadopted decides drop vs. destroy.
    it(`collects a crashed claim: drops the row when adopted, destroys the machine when not`, async () => {
        const stale = new Date(Date.now() - 16 * 60 * 1000);
        const del = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        const adopted = fakePrisma({
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow({ state: `claimed`, updatedAt: stale })]), delete: del },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue({ id: `h1` }) },
        });
        await reconcileHostedPool(adopted, config({ regionEu: `` }), logger);
        expect(del).toHaveBeenCalledWith({ where: { id: `p1` } });
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(poolRow().appName))).toBe(false);

        del.mockClear();
        calls.length = 0;
        const unadopted = fakePrisma({
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow({ state: `claimed`, updatedAt: stale })]), delete: del },
        });
        await reconcileHostedPool(unadopted, config({ regionEu: `` }), logger);
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(poolRow().appName))).toBe(true);
        expect(del).toHaveBeenCalledWith({ where: { id: `p1` } });
    });

    it(`drains around an adopted claim: the row goes, the user's machine stays`, async () => {
        const stale = new Date(Date.now() - 16 * 60 * 1000);
        const del = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        const prisma = fakePrisma({
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow({ state: `claimed`, updatedAt: stale })]), delete: del },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue({ id: `h1` }) },
        });
        await reconcileHostedPool(prisma, config({ poolSize: 0 }), logger);
        expect(del).toHaveBeenCalledWith({ where: { id: `p1` } });
        expect(calls.some((entry) => entry.method === `DELETE`)).toBe(false);
    });

    it(`leaves a fresh claim alone: it is a hand-off in flight, not stock and not garbage`, async () => {
        const del = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        const prisma = fakePrisma({
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow({ state: `claimed` })]), delete: del },
        });
        await reconcileHostedPool(prisma, config({ regionEu: `` }), logger);
        expect(del).not.toHaveBeenCalled();
        // Not counted as stock either, so its slot is rebuilt.
        expect(calls.filter((entry) => entry.method === `POST` && entry.url.includes(`/machines`))).toHaveLength(1);
    });
});
