import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { reconcileHostedPool, WARM_BOOT_EXEC } from "./hosted-pool.js";

/* THE POOL'S PROMISES, pinned: a warm machine never runs the sandbox (its one boot is a no-op), the stock
 * converges on the target per region and only per region (the EEA caller's machine must already BE in the
 * EEA), a drifted image is worthless and rebuilt, and turning the pool off empties it rather than stranding
 * the platform's own machines behind a reaper that spares them. */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const config = (over?: Partial<Config[`hosted`]>): Config =>
    ({
        webOrigin: `https://app.test`,
        google: { clientId: `gcid` },
        api: { url: `https://api.test` },
        zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
        hosted: {
            flyApiToken: `fly`,
            flyOrg: `intentic`,
            region: `iad`,
            regionEu: `waw`,
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
            ...over,
        },
    }) as unknown as Config;

// A pool row as the reconcile reads it. Fresh stamps by default — staleness is opted into per case.
const poolRow = (over?: Record<string, unknown>) => ({
    id: `p1`,
    appName: `intentic-sbx-pool-abc123`,
    machineId: `m1`,
    volumeId: `vol_1`,
    region: `iad`,
    image: `ghcr.io/intentic/sandbox:stable`,
    state: `ready`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
});

const fakePrisma = (overrides?: Record<string, Record<string, ReturnType<typeof vi.fn>>>) =>
    ({
        hostedPoolMachine: {
            findMany: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockResolvedValue({}),
            update: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
            ...overrides?.[`hostedPoolMachine`],
        },
        hostedMachine: { findUnique: vi.fn().mockResolvedValue(null), ...overrides?.[`hostedMachine`] },
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
    it(`builds toward the target in BOTH regions, and the warm boot is a no-op over the real image`, async () => {
        const create = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        await reconcileHostedPool(fakePrisma({ hostedPoolMachine: { create } }), config(), logger);
        // One machine per region — the residency promise makes a warm iad box useless to an EEA caller.
        const machines = calls.filter((entry) => entry.method === `POST` && entry.url.includes(`/machines`));
        expect(machines).toHaveLength(2);
        const regions = machines.map((entry) => (entry.body as { region: string }).region).toSorted();
        expect(regions).toEqual([`iad`, `waw`]);
        // The pull is the point; the sandbox must not run — real image, no-op exec, and no identity at all.
        const posted = machines[0]?.body as { config: { image: string; init: { exec: string[] }; env: Record<string, string> } };
        expect(posted.config.image).toBe(`ghcr.io/intentic/sandbox:stable`);
        expect(posted.config.init).toEqual({ exec: [...WARM_BOOT_EXEC] });
        expect(posted.config.env[`CONNECT_TOKEN`]).toBeUndefined();
        expect(posted.config.env[`OWNER_EMAIL`]).toBeUndefined();
        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls[0]?.[0]).toMatchObject({ data: { state: `building`, image: `ghcr.io/intentic/sandbox:stable` } });
    });

    it(`flips a build to ready once its no-op boot is observed stopped`, async () => {
        const update = vi.fn().mockResolvedValue({});
        stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ id: `m1`, state: `stopped` }) },
            ...builderRoutes,
        ]);
        const prisma = fakePrisma({
            hostedPoolMachine: {
                findMany: vi.fn().mockResolvedValue([poolRow({ state: `building` }), poolRow({ id: `p2`, appName: `intentic-sbx-pool-waw`, region: `waw` })]),
                update,
            },
        });
        await reconcileHostedPool(prisma, config(), logger);
        expect(update).toHaveBeenCalledWith({ where: { id: `p1` }, data: { state: `ready` } });
    });

    it(`replaces a machine whose image drifted from config — its warm rootfs is the wrong rootfs`, async () => {
        const del = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        const prisma = fakePrisma({
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow({ image: `ghcr.io/intentic/sandbox:old` })]), delete: del },
        });
        await reconcileHostedPool(prisma, config({ regionEu: `` }), logger);
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(`intentic-sbx-pool-abc123`))).toBe(true);
        expect(del).toHaveBeenCalledWith({ where: { id: `p1` } });
        // …and the slot is refilled in the same pass.
        expect(calls.filter((entry) => entry.method === `POST` && entry.url.includes(`/machines`))).toHaveLength(1);
    });

    it(`drains the whole pool when it is switched off — nothing in it is ever somebody's`, async () => {
        const del = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        const prisma = fakePrisma({
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow(), poolRow({ id: `p2`, appName: `intentic-sbx-pool-two` })]), delete: del },
        });
        await reconcileHostedPool(prisma, config({ poolSize: 0 }), logger);
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(2);
        expect(del).toHaveBeenCalledTimes(2);
        expect(calls.some((entry) => entry.method === `POST`)).toBe(false);
    });

    /* A crashed claim is the one row whose app may already carry a sandbox's tokens. Adopted (a HostedMachine
     * row took the app) means the hand-off actually landed — only the pool row is stale. Unadopted means a
     * half-branded machine belongs to nobody, and it must go entirely. */
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
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(`pool-abc123`))).toBe(false);

        del.mockClear();
        calls.length = 0;
        const unadopted = fakePrisma({
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow({ state: `claimed`, updatedAt: stale })]), delete: del },
        });
        await reconcileHostedPool(unadopted, config({ regionEu: `` }), logger);
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(`pool-abc123`))).toBe(true);
        expect(del).toHaveBeenCalledWith({ where: { id: `p1` } });
    });

    /* Turning the pool OFF is a drain, and the drain must make the same distinction the live pass does: an
     * ADOPTED app is a user's machine wearing a pool name, and destroying it because the pool closed would be
     * the platform deleting someone's workspace as housekeeping. */
    it(`drains around an adopted claim — the row goes, the user's machine stays`, async () => {
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

    it(`leaves a fresh claim alone — it is a hand-off in flight, not stock and not garbage`, async () => {
        const del = vi.fn().mockResolvedValue({});
        const calls = stubFetch(builderRoutes);
        const prisma = fakePrisma({
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow({ state: `claimed` })]), delete: del },
        });
        await reconcileHostedPool(prisma, config({ regionEu: `` }), logger);
        expect(del).not.toHaveBeenCalled();
        // …and it does not count as stock either: the slot it vacated is rebuilt.
        expect(calls.filter((entry) => entry.method === `POST` && entry.url.includes(`/machines`))).toHaveLength(1);
    });
});
