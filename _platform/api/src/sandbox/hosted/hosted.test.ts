import { call, ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrpcContext } from "../../context.js";
import type { Config } from "../../config.js";
import { sandboxRoutes } from "../sandbox.routes.js";
import { hostedEnabled, provisionHosted, reapHostedOrphans, wakeHosted } from "./hosted.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

// The hosted lane's config, enabled — tests narrow fields per case.
const config = (over?: Record<string, unknown>): Config =>
    ({
        webOrigin: `https://app.test`,
        google: { clientId: `gcid` },
        api: { url: `https://api.test` },
        secrets: { key: `` },
        intenticCloudflare: { apiToken: `cf`, zone: `sbx.test`, reapDryRun: true }, zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
        hosted: {
            flyApiToken: `fly`,
            flyOrg: `intentic`,
            region: `iad`,
            appPrefix: `intentic-sbx`,
            image: `ghcr.io/intentic/sandbox:stable`,
            cpus: 4,
            memoryMb: 8192,
            volumeGb: 20,
            perUser: 1,
            idleStopMinutes: 20,
        },
        ...over,
    }) as unknown as Config;

const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>>) => overrides as unknown as OrpcContext[`prisma`];

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
        expect(created).toHaveBeenCalledWith({
            data: { sandboxId: `s1`, appName: result.appName, machineId: `m1`, volumeId: `vol_1`, region: `iad` },
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
    it(`destroys only our-prefix apps whose row is gone; everything else in the org is untouched`, async () => {
        const calls = stubFetch([
            {
                match: (method, url) => method === `GET` && url.includes(`/apps?org_slug=`),
                respond: () => json({ apps: [{ name: `intentic-sbx-live` }, { name: `intentic-sbx-orphan` }, { name: `unrelated-app` }] }),
            },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        const prisma = fakePrisma({ hostedMachine: { findMany: vi.fn().mockResolvedValue([{ appName: `intentic-sbx-live` }]) } });
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
        expect(on).toEqual({ enabled: true, remaining: 1 });
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
            sandbox: { findFirst: vi.fn().mockResolvedValue(ownedRow), findUniqueOrThrow: vi.fn().mockResolvedValue({ ...ownedRow, hosted: { region: `iad` } }) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue({ appName: `intentic-sbx-a`, machineId: `m1` }), count: vi.fn() },
        });
        const summary = await call(sandboxRoutes.hostedProvision, { sandboxId: `s1` }, { context: routeContext({ prisma }) });
        expect(summary.hosted).toEqual({ region: `iad` });
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

    it(`wake 404s for a sandbox that is not hosted (or not the caller's)`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(null) } });
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).rejects.toBeInstanceOf(ORPCError);
    });

    it(`wake starts the machine for an accepted member's hosted sandbox`, async () => {
        stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ ok: true }) }]);
        const findFirst = vi.fn().mockResolvedValue({ id: `s1`, hosted: { appName: `intentic-sbx-a`, machineId: `m1`, region: `iad` } });
        const result = await call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: fakePrisma({ sandbox: { findFirst } }) }) });
        expect(result).toEqual({ ok: true });
        // The access query admits owner OR accepted member — the OR is the contract here.
        expect(findFirst.mock.calls[0]?.[0]?.where?.OR).toHaveLength(2);
    });
});
