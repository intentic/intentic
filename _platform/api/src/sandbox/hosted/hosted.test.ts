import { call, ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrpcContext } from "../../context.js";
import type { Config } from "../../config.js";
import { sandboxRoutes } from "../sandbox.routes.js";
import { hostedEnabled, provisionHosted, reapHostedOrphans, wakeHosted } from "./hosted.js";
import { forgetNamespace } from "../zrok-provision.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

// The hosted lane's config, enabled — tests narrow fields per case.
const config = (over?: Record<string, unknown>): Config =>
    ({
        webOrigin: `https://app.test`,
        google: { clientId: `gcid` },
        api: { url: `https://api.test` },
        secrets: { key: `` },
        intenticCloudflare: { apiToken: `cf`, zone: `sbx.test`, reapDryRun: true },
        zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
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
        },
        ...over,
    }) as unknown as Config;

/* Every model the hosted routes touch, stubbed to the harmless answer, with the case's own overrides on top.
 * The defaults matter: the hour meter reads membership (absent ⇒ not a member ⇒ metered) and the month's
 * usage (absent ⇒ nothing spent) on paths whose SUBJECT is something else entirely, and a fixture that
 * omitted them would fail those tests for a reason none of them are about. */
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>>) =>
    ({
        membership: { findUnique: vi.fn().mockResolvedValue(null) },
        hostedUsage: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
        // The claim's transactional hand-off: the stub just settles what the model calls already returned.
        $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
        ...overrides,
        // An empty pool by default, so every test not ABOUT the pool exercises the cold path it always did.
        hostedPoolMachine: {
            findMany: vi.fn().mockResolvedValue([]),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            delete: vi.fn().mockResolvedValue({}),
            ...overrides[`hostedPoolMachine`],
        },
        hostedMachine: { update: vi.fn().mockResolvedValue({}), ...overrides[`hostedMachine`] },
    }) as unknown as OrpcContext[`prisma`];

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

afterEach(() => {
    vi.unstubAllGlobals();
    forgetNamespace();
});

describe(`hostedEnabled`, () => {
    it(`needs BOTH the Fly credential and the tunnel fabric — machines without reachability boot to nothing`, () => {
        expect(hostedEnabled(config())).toBe(true);
        expect(hostedEnabled(config({ hosted: { ...config().hosted, flyApiToken: `` } }))).toBe(false);
        expect(hostedEnabled(config({ zrok: { ...config().zrok, adminToken: `` } }))).toBe(false);
    });
});

describe(`provisionHosted`, () => {
    const args = {
        sandboxId: `s1`,
        connectToken: `t0k3n`,
        grant: { accountToken: `acct-1`, namespaceToken: `ns-1`, hostname: `sandbox-abc.sbx.test`, apiEndpoint: `https://zrok2.sbx.test` },
        ownerEmail: `owner@example.com`,
        // The route decides this from the caller's country (region.test.ts covers the pick itself).
        region: `iad`,
    };

    it(`creates app → volume → machine and stamps the row; the env is the contract's vocabulary`, async () => {
        const created = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
        ]);
        const result = await provisionHosted(fakePrisma({ hostedMachine: { create: created } }) as never, config(), logger, args);
        expect(result.region).toBe(`iad`);
        expect(result.appName.startsWith(`intentic-sbx-`)).toBe(true);
        const machine = calls.find((entry) => entry.url.includes(`/machines`))?.body as {
            config: { env: Record<string, string>; mounts: { volume: string }[] };
        };
        expect(machine.config.mounts).toEqual([{ volume: `vol_1`, path: `/data` }]);
        expect(machine.config.env[`CONNECT_TOKEN`]).toBe(`t0k3n`);
        expect(machine.config.env[`ZROK_TOKEN`]).toBe(`acct-1`);
        expect(machine.config.env[`ZROK_NAMESPACE`]).toBe(`ns-1`);
        expect(machine.config.env[`ZROK_API`]).toBe(`https://zrok2.sbx.test`);
        expect(machine.config.env[`SANDBOX_PUBLIC_URL`]).toBe(`https://sandbox-abc.sbx.test`);
        expect(machine.config.env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        expect(machine.config.env[`IDLE_STOP_MINUTES`]).toBe(`20`);
        expect(machine.config.env[`SANDBOX_VM`]).toBe(`1`);
        // `wokeAt` opens the hour meter's first stretch: the machine is running from the moment it is made,
        // so provisioning starts the clock rather than handing out an uncounted first session.
        expect(created).toHaveBeenCalledWith({
            data: { sandboxId: `s1`, appName: result.appName, machineId: `m1`, volumeId: `vol_1`, region: `iad`, wokeAt: expect.any(Date) },
        });
    });

    it(`a failure after the app exists deletes the app again so a retry starts clean`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ error: `no capacity` }, 422) },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        await expect(provisionHosted(fakePrisma({ hostedMachine: { create: vi.fn() } }) as never, config(), logger, args)).rejects.toThrow(
            /no capacity/,
        );
        expect(calls.some((entry) => entry.method === `DELETE`)).toBe(true);
    });

    // A warm machine matching the caller's region: identity written in (the SAME composer the cold path
    // uses, so nothing can drift), no-op override written out, machine started, hour meter opened at claim.
    const poolRow = {
        id: `p1`,
        appName: `intentic-sbx-pool-abc123`,
        machineId: `m7`,
        volumeId: `vol_7`,
        region: `iad`,
        image: `ghcr.io/intentic/sandbox:stable`,
        state: `ready`,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    it(`claims a warm machine when one is waiting: brands it, starts it, and opens the meter at claim`, async () => {
        const created = vi.fn().mockResolvedValue({});
        const poolDelete = vi.fn().mockResolvedValue({});
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ id: `m7`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7/start`), respond: () => json({ ok: true }) },
        ]);
        const prisma = fakePrisma({
            hostedMachine: { create: created },
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow]), updateMany, delete: poolDelete },
        });
        const result = await provisionHosted(prisma as never, config(), logger, args);
        expect(result).toEqual({ appName: `intentic-sbx-pool-abc123`, region: `iad` });
        // The row was WON, not just read — the guarded update is what keeps two claimers off one machine.
        expect(updateMany).toHaveBeenCalledWith({ where: { id: `p1`, state: `ready` }, data: { state: `claimed` } });
        // The identity goes in before the machine ever runs the sandbox, and the no-op boot override goes out.
        const update = calls.find((entry) => entry.url.endsWith(`/machines/m7`))?.body as {
            config: { env: Record<string, string>; init?: unknown; mounts: { volume: string }[] };
            skip_launch: boolean;
        };
        expect(update.config.env[`CONNECT_TOKEN`]).toBe(`t0k3n`);
        expect(update.config.env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        expect(update.config.env[`SANDBOX_PUBLIC_URL`]).toBe(`https://sandbox-abc.sbx.test`);
        expect(update.config.init).toBeUndefined();
        expect(update.config.mounts).toEqual([{ volume: `vol_7`, path: `/data` }]);
        expect(update.skip_launch).toBe(true);
        expect(calls.some((entry) => entry.url.endsWith(`/machines/m7/start`))).toBe(true);
        // The user's clock starts here — the pool's own no-op boot was the platform's cost, not theirs.
        expect(created).toHaveBeenCalledWith({
            data: {
                sandboxId: `s1`,
                appName: `intentic-sbx-pool-abc123`,
                machineId: `m7`,
                volumeId: `vol_7`,
                region: `iad`,
                wokeAt: expect.any(Date),
            },
        });
        expect(poolDelete).toHaveBeenCalledWith({ where: { id: `p1` } });
    });

    it(`ignores warm machines in the wrong region — the residency promise beats the fast path`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
        ]);
        const findMany = vi.fn().mockResolvedValue([]);
        const prisma = fakePrisma({ hostedMachine: { create: vi.fn().mockResolvedValue({}) }, hostedPoolMachine: { findMany } });
        await provisionHosted(prisma as never, config(), logger, { ...args, region: `arn` });
        // The pool was asked ONLY for the caller's region (and the current image) — never "anything warm".
        expect(findMany).toHaveBeenCalledWith({
            where: { region: `arn`, state: `ready`, image: `ghcr.io/intentic/sandbox:stable` },
            orderBy: { createdAt: `asc` },
        });
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(true);
    });

    it(`falls back to a cold build when the claim stumbles — the reader is owed a machine, not a pool hit`, async () => {
        const created = vi.fn().mockResolvedValue({});
        const poolDelete = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            // The brand fails on the warm machine…
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ error: `host unavailable` }, 500) },
            // …and the cold path proceeds as if the pool never existed.
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
        ]);
        const prisma = fakePrisma({
            hostedMachine: { create: created },
            hostedPoolMachine: {
                findMany: vi.fn().mockResolvedValue([poolRow]),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                delete: poolDelete,
            },
        });
        const result = await provisionHosted(prisma as never, config(), logger, args);
        expect(result.appName.startsWith(`intentic-sbx-`)).toBe(true);
        expect(result.appName).not.toBe(`intentic-sbx-pool-abc123`);
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(true);
        // The won row is NOT put back: a half-branded machine already carries this sandbox's tokens, so it
        // stays `claimed` for the reconcile job to collect rather than becoming someone else's "warm" machine.
        expect(poolDelete).not.toHaveBeenCalled();
    });
});

describe(`wakeHosted`, () => {
    it(`treats "already running" as success — the browser's daemon probe is the real verdict`, async () => {
        stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ error: `machine is started` }, 422) },
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ id: `m1`, state: `started` }) },
        ]);
        await expect(wakeHosted(config(), { appName: `intentic-sbx-a`, machineId: `m1` })).resolves.toBeUndefined();
    });

    it(`propagates a refusal on a machine that is genuinely not coming up`, async () => {
        stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ error: `host unavailable` }, 500) },
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ id: `m1`, state: `stopped` }) },
        ]);
        await expect(wakeHosted(config(), { appName: `intentic-sbx-a`, machineId: `m1` })).rejects.toThrow(/host unavailable/);
    });
});

describe(`reapHostedOrphans`, () => {
    it(`destroys only our-prefix apps whose row is gone; live machines, pool machines and strangers stand`, async () => {
        const calls = stubFetch([
            {
                match: (method, url) => method === `GET` && url.includes(`/apps?org_slug=`),
                respond: () =>
                    json({
                        apps: [
                            { name: `intentic-sbx-live` },
                            { name: `intentic-sbx-orphan` },
                            // A warm machine waiting in the pool is OURS ON PURPOSE — a reaper that eats the
                            // pool every night would silently turn every claim back into a cold build.
                            { name: `intentic-sbx-pool-warm1` },
                            { name: `unrelated-app` },
                        ],
                    }),
            },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        const prisma = fakePrisma({
            hostedMachine: { findMany: vi.fn().mockResolvedValue([{ appName: `intentic-sbx-live` }]) },
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([{ appName: `intentic-sbx-pool-warm1` }]) },
        });
        await reapHostedOrphans(prisma as never, config(), logger);
        const deleted = calls.filter((entry) => entry.method === `DELETE`).map((entry) => entry.url);
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toContain(`intentic-sbx-orphan`);
    });

    it(`does nothing when the lane is off`, async () => {
        const fetchSpy = stubFetch([]);
        await reapHostedOrphans(fakePrisma({}) as never, config({ hosted: { ...config().hosted, flyApiToken: `` } }), logger);
        expect(fetchSpy).toHaveLength(0);
    });
});

describe(`sandbox routes: the hosted lane's gates`, () => {
    const user = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };
    const routeContext = (over?: Partial<OrpcContext>): OrpcContext =>
        ({ prisma: fakePrisma({}), config: config(), user, logger, ...over }) as OrpcContext;

    it(`hostedOffer answers disabled/0 when the lane is off, and the remaining allowance when on`, async () => {
        const off = await call(sandboxRoutes.hostedOffer, undefined, {
            context: routeContext({ config: config({ hosted: { ...config().hosted, flyApiToken: `` } }) }),
        });
        expect(off).toEqual({ enabled: false, remaining: 0 });
        const on = await call(sandboxRoutes.hostedOffer, undefined, {
            context: routeContext({ prisma: fakePrisma({ hostedMachine: { count: vi.fn().mockResolvedValue(0) } }) }),
        });
        // A non-member on a platform with a ceiling is told the ceiling BEFORE spending any of it, so the
        // lane's card can caption itself honestly rather than saying "Free" and correcting itself later.
        expect(on).toEqual({ enabled: true, remaining: 1, hours: { allowance: 40, remaining: 40 } });
    });

    /* The hours block is ABSENT for anyone the ceiling does not apply to, rather than present and generous.
     * A member being shown a limit they do not have is the failure this shape exists to prevent — and the
     * same absence covers a self-hosted platform that meters nothing. */
    it(`hostedOffer tells a member nothing about hours, because none apply to them`, async () => {
        const member = fakePrisma({
            hostedMachine: { count: vi.fn().mockResolvedValue(0) },
            membership: { findUnique: vi.fn().mockResolvedValue({ status: `active` }) },
        });
        expect(await call(sandboxRoutes.hostedOffer, undefined, { context: routeContext({ prisma: member }) })).toEqual({
            enabled: true,
            remaining: 1,
        });
        const uncapped = routeContext({
            prisma: fakePrisma({ hostedMachine: { count: vi.fn().mockResolvedValue(0) } }),
            config: config({ hosted: { ...config().hosted, monthlyHours: 0 } }),
        });
        expect(await call(sandboxRoutes.hostedOffer, undefined, { context: uncapped })).toEqual({ enabled: true, remaining: 1 });
    });

    /* The gate itself: a non-member who has spent the month is refused the wake, and told both ways out. The
     * refusal is PAYMENT_REQUIRED so the editor can offer the membership without reading the sentence. */
    it(`wake refuses a non-member whose month is spent, and never touches the provider`, async () => {
        const fetchSpy = stubFetch([]);
        const spent = fakePrisma({
            sandbox: {
                findFirst: vi
                    .fn()
                    .mockResolvedValue({ id: `s1`, ownerId: `u1`, hosted: { id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null } }),
            },
            hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 40 * 60 }) },
        });
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: spent }) })).rejects.toMatchObject({
            code: `PAYMENT_REQUIRED`,
        });
        expect(fetchSpy).toHaveLength(0);
    });

    // Same spent month, but the owner is a member: unmetered, so the machine starts and the meter is not read.
    it(`wake starts a member's machine however much of the month has been used`, async () => {
        stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ ok: true }) }]);
        const spentMember = fakePrisma({
            sandbox: {
                findFirst: vi
                    .fn()
                    .mockResolvedValue({ id: `s1`, ownerId: `u1`, hosted: { id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null } }),
            },
            hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 40 * 60 }) },
            membership: { findUnique: vi.fn().mockResolvedValue({ status: `active` }) },
        });
        expect(await call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: spentMember }) })).toEqual({ ok: true });
    });

    // The row every provision test starts from: created the ordinary way, tunnel already claimed from the pool.
    const ownedRow = {
        id: `s1`,
        name: `mine`,
        image: null,
        ownerId: `u1`,
        token: `tok`,
        tunnelToken: `tt`,
        tunnelHostname: `sandbox-a.sbx.test`,
        zrokToken: `acct-1`,
        daemonUrl: null,
        lastSeenAt: null,
        setupCodeClaimedAt: null,
        setupReport: null,
        cloud: null,
    };

    it(`hostedProvision refuses over-quota before touching any provider`, async () => {
        const fetchSpy = stubFetch([]);
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(1) },
        });
        await expect(call(sandboxRoutes.hostedProvision, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).rejects.toMatchObject({
            code: `BAD_REQUEST`,
        });
        expect(fetchSpy).toHaveLength(0);
    });

    it(`hostedProvision 404s when the lane is off — a platform without the config simply has no such route`, async () => {
        await expect(
            call(
                sandboxRoutes.hostedProvision,
                { sandboxId: `s1` },
                { context: routeContext({ config: config({ hosted: { ...config().hosted, flyOrg: `` } }) }) },
            ),
        ).rejects.toMatchObject({ code: `NOT_FOUND` });
    });

    // Idempotence is what makes a double-click (or a retry after a slow response) free rather than a second
    // machine nobody asked for and everybody pays for.
    it(`hostedProvision answers with the sandbox it already hosts, without creating anything`, async () => {
        const fetchSpy = stubFetch([]);
        const prisma = fakePrisma({
            sandbox: {
                findFirst: vi.fn().mockResolvedValue(ownedRow),
                findUniqueOrThrow: vi.fn().mockResolvedValue({ ...ownedRow, hosted: { region: `iad`, appName: `intentic-sbx-pool-abc123` } }),
            },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue({ appName: `intentic-sbx-pool-abc123`, machineId: `m1` }), count: vi.fn() },
        });
        const summary = await call(sandboxRoutes.hostedProvision, { sandboxId: `s1` }, { context: routeContext({ prisma }) });
        // `warm` is read off the app name (a pool claim keeps its pool name) — the wait card's promise rides on it.
        expect(summary.hosted).toEqual({ region: `iad`, warm: true });
        expect(fetchSpy).toHaveLength(0);
    });

    // The lane switch: a sandbox nobody ever connected to can hand its machine back. One that HAS connected
    // cannot — that is a workspace with files on it, and destroying its machine belongs to the delete dialog.
    it(`hostedRelease destroys the machine of a never-started sandbox and refuses on a live one`, async () => {
        const calls = stubFetch([{ match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) }]);
        const machineDelete = vi.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(ownedRow), findUniqueOrThrow: vi.fn().mockResolvedValue({ ...ownedRow, hosted: null }) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue({ appName: `intentic-sbx-a` }), delete: machineDelete },
        });
        const summary = await call(sandboxRoutes.hostedRelease, { sandboxId: `s1` }, { context: routeContext({ prisma }) });
        expect(summary.hosted).toBeNull();
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(1);
        expect(machineDelete).toHaveBeenCalled();

        const live = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue({ ...ownedRow, lastSeenAt: new Date() }) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue({ appName: `intentic-sbx-a` }), delete: vi.fn() },
        });
        await expect(call(sandboxRoutes.hostedRelease, { sandboxId: `s1` }, { context: routeContext({ prisma: live }) })).rejects.toMatchObject({
            code: `BAD_REQUEST`,
        });
    });

    it(`hostedRestart refreshes the current image onto the existing volume before starting`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1/stop`), respond: () => json({ ok: true }) },
            {
                match: (method, url) => method === `GET` && url.endsWith(`/api/v2/namespaces`),
                respond: () => json([{ namespaceToken: `ns-1`, name: `public`, open: true }]),
            },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ id: `m1`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1/start`), respond: () => json({ ok: true }) },
        ]);
        const hosted = {
            id: `h1`,
            appName: `intentic-sbx-a`,
            machineId: `m1`,
            volumeId: `vol_1`,
            region: `iad`,
            wokeAt: null,
        };
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue(hosted), update: vi.fn().mockResolvedValue({}) },
        });

        expect(await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ ok: true });
        const update = calls.find((entry) => entry.url.endsWith(`/machines/m1`))?.body as {
            config: { image: string; mounts: { volume: string; path: string }[]; env: Record<string, string> };
            skip_launch: boolean;
        };
        expect(update.config.image).toBe(`ghcr.io/intentic/sandbox:stable`);
        expect(update.config.mounts).toEqual([{ volume: `vol_1`, path: `/data` }]);
        expect(update.config.env[`CONNECT_TOKEN`]).toBe(`tok`);
        expect(update.config.env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        expect(update.skip_launch).toBe(true);
        expect(calls.findIndex((entry) => entry.url.endsWith(`/machines/m1`))).toBeLessThan(
            calls.findIndex((entry) => entry.url.endsWith(`/machines/m1/start`)),
        );
    });

    it(`wake 404s for a sandbox that is not hosted (or not the caller's)`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(null) } });
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).rejects.toBeInstanceOf(ORPCError);
    });

    it(`wake starts the machine for an accepted member's hosted sandbox`, async () => {
        stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ ok: true }) }]);
        const findFirst = vi.fn().mockResolvedValue({ id: `s1`, hosted: { appName: `intentic-sbx-a`, machineId: `m1`, region: `iad` } });
        const result = await call(
            sandboxRoutes.wake,
            { sandboxId: `s1` },
            { context: routeContext({ prisma: fakePrisma({ sandbox: { findFirst } }) }) },
        );
        expect(result).toEqual({ ok: true });
        // The access query admits owner OR accepted member — the OR is the contract here.
        expect(findFirst.mock.calls[0]?.[0]?.where?.OR).toHaveLength(2);
    });
});
