import { Prisma } from "@intentic-app/prisma";
import { call, ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrpcContext } from "../../context.js";
import type { Config } from "../../config.js";
import { sandboxRoutes } from "../sandbox.routes.js";
import { HostedAlreadyProvisioned, hostedEnabled, hostedInstanceId, provisionHosted, reapHostedOrphans, wakeHosted } from "./hosted.js";
import { ensureReachability } from "../reachability.js";
import { testIngressConfig } from "../../testing.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

// The hosted lane's config, enabled: tests narrow fields per case.
const config = (over?: Record<string, unknown>): Config =>
    ({
        webOrigin: `https://app.test`,
        google: { clientId: `gcid` },
        api: { url: `https://api.test` },
        secrets: { key: `` },
        intenticCloudflare: { apiToken: `cf`, zone: `sbx.test`, reapDryRun: true },
        ingress: { ...testIngressConfig },
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
        pool: { compEmails: `` },
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

// `respond` receives the URL so a route can answer per app (the orphan sweep asks each app about its own
// machines, and what those machines say is the whole subject of its tests).
const stubFetch = (routes: { match: (method: string, url: string) => boolean; respond: (url: string) => Response }[]) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? `GET`;
        calls.push({ method, url: String(url), ...(typeof init?.body === `string` ? { body: JSON.parse(init.body) } : {}) });
        const route = routes.find((candidate) => candidate.match(method, String(url)));
        if (!route) {
            throw new Error(`unexpected fetch: ${method} ${String(url)}`);
        }
        return Promise.resolve(route.respond(String(url)));
    });
    return calls;
};

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

// This deployment's stamp, derived from its own API URL, so the fixtures below say what a machine of OURS
// looks like without hard-coding a hash anybody would have to update by hand.
const INSTANCE = hostedInstanceId(config());
// A Fly machine as the orphan sweep reads it: whose it is, and when it was made.
const flyMachine = (over: { platform?: string; ageMinutes?: number } = {}) => ({
    id: `m1`,
    state: `stopped`,
    created_at: new Date(Date.now() - (over.ageMinutes ?? 120) * 60_000).toISOString(),
    config: { metadata: over.platform === undefined ? {} : { intentic_role: `warm`, intentic_platform: over.platform } },
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`hostedEnabled`, () => {
    it(`needs BOTH the Fly credential and the reachability fabric: machines without it boot to nothing`, () => {
        expect(hostedEnabled(config())).toBe(true);
        expect(hostedEnabled(config({ hosted: { ...config().hosted, flyApiToken: `` } }))).toBe(false);
        expect(hostedEnabled(config({ ingress: { ...testIngressConfig, signingKey: `` } }))).toBe(false);
    });
});

/* WHO THIS DEPLOYMENT IS, and the reason it is not just the API URL. The laptop that destroyed production's
 * fleet held a COPY of production's env file, which is how it had the Fly token at all, and a copy carries
 * API_URL with it. What a copy cannot carry is the database: a laptop cannot reach production's Postgres, so
 * it points at its own, and that is the difference the id has to be made of. */
describe(`hostedInstanceId`, () => {
    const withDb = (url: string, over: Record<string, unknown> = {}) => config({ database: { url }, ...over });

    it(`is stable for one deployment across restarts and replicas`, () => {
        expect(hostedInstanceId(withDb(`postgresql://app:app@db:5432/intentic`))).toBe(
            hostedInstanceId(withDb(`postgresql://app:app@db:5432/intentic`)),
        );
    });

    it(`differs for a copy of the same env file pointed at its own database`, () => {
        const production = hostedInstanceId(withDb(`postgresql://app:secret@postgres:5432/intentic`));
        const laptop = hostedInstanceId(withDb(`postgresql://app:app@localhost:5440/app`));
        expect(laptop).not.toBe(production);
    });

    // …and the mirror image: a staging box restored from a production dump carries the same database NAME and
    // answers on its own address.
    it(`differs for the same database name reached at a different address`, () => {
        const production = hostedInstanceId(withDb(`postgresql://app:app@db:5432/intentic`));
        const staging = hostedInstanceId(withDb(`postgresql://app:app@db:5432/intentic`, { api: { url: `https://api.staging.test` } }));
        expect(staging).not.toBe(production);
    });

    // The credential never goes into the stamp: this is a label Fly stores in plaintext and shows to anyone
    // who can read the machine.
    it(`ignores the database's credentials, so the same server under two passwords is one deployment`, () => {
        expect(hostedInstanceId(withDb(`postgresql://app:one@db:5432/intentic`))).toBe(hostedInstanceId(withDb(`postgresql://app:two@db:5432/intentic`)));
    });

    it(`hands identity over when HOSTED_INSTANCE_ID says so`, () => {
        expect(hostedInstanceId(withDb(`postgresql://app:app@db:5432/intentic`, { hosted: { ...config().hosted, instanceId: `handed-over` } }))).toBe(
            `handed-over`,
        );
    });
});

describe(`provisionHosted`, () => {
    const args = {
        sandboxId: `s1`,
        connectToken: `t0k3n`,
        // The reachability the route signs and hands down. Produced by the real thing rather than transcribed,
        // so the env assertions below pin the HANDDOWN and not a shape somebody typed twice.
        grant: ensureReachability(config(), { id: `s1`, token: `t0k3n` }),
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
            config: { env: Record<string, string>; mounts: { volume: string }[]; metadata: Record<string, string> };
        };
        expect(machine.config.mounts).toEqual([{ volume: `vol_1`, path: `/data` }]);
        // The platform stamp rides with the role: it is what lets THIS deployment's reaper tell its own
        // machines from those of anything else sharing the Fly org and credential (fly.ts, hosted.ts).
        expect(machine.config.metadata).toEqual({ intentic_role: `sandbox`, intentic_sandbox: `s1`, intentic_platform: INSTANCE });
        expect(machine.config.env[`CONNECT_TOKEN`]).toBe(`t0k3n`);
        // The pair the daemon reads to open its outbound tunnel, in the contract's own vocabulary.
        expect(machine.config.env[`SANDBOX_GRANT`]).toBe(args.grant.grant);
        expect(machine.config.env[`INGRESS_URL`]).toBe(`https://ingress.sbx.test`);
        expect(machine.config.env[`SANDBOX_PUBLIC_URL`]).toBe(`https://${args.grant.hostname}`);
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
        // The row was WON, not just read: the guarded update is what keeps two claimers off one machine.
        expect(updateMany).toHaveBeenCalledWith({ where: { id: `p1`, state: `ready` }, data: { state: `claimed` } });
        // The identity goes in before the machine ever runs the sandbox, and the no-op boot override goes out.
        const update = calls.find((entry) => entry.url.endsWith(`/machines/m7`))?.body as {
            config: { env: Record<string, string>; init?: unknown; mounts: { volume: string }[]; metadata: Record<string, string> };
            skip_launch?: boolean;
        };
        // The stamp flips with the identity, in the same call: the app name will say `pool` forever, so this
        // is the only thing that can tell Fly this machine stopped being the platform's stock.
        expect(update.config.metadata).toEqual({ intentic_role: `sandbox`, intentic_sandbox: `s1`, intentic_platform: INSTANCE });
        expect(update.config.env[`CONNECT_TOKEN`]).toBe(`t0k3n`);
        expect(update.config.env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        expect(update.config.env[`SANDBOX_PUBLIC_URL`]).toBe(`https://${args.grant.hostname}`);
        expect(update.config.init).toBeUndefined();
        expect(update.config.mounts).toEqual([{ volume: `vol_7`, path: `/data` }]);
        // The branding call IS the launch. Holding it back (skip_launch) and starting afterwards raced Fly's
        // `replacing` state and refused every claim this pool ever made.
        expect(update.skip_launch).toBeUndefined();
        expect(calls.some((entry) => entry.url.endsWith(`/machines/m7/start`))).toBe(true);
        // The user's clock starts here: the pool's own no-op boot was the platform's cost, not theirs.
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

    /* THE OUTAGE THIS PINS SHUT, read off production logs: the branding update puts a machine through Fly's
     * `replacing` state for a few seconds, and the confirming start lands inside that window and is refused
     * with `412 machine getting replaced`. Every claim died there, both warm machines of the caller's region
     * were burned and stranded per sign-up, and every reader was handed the cold build the pool exists to
     * spare. A machine Fly reports as replacing is a machine coming up: the claim must finish, not fall back. */
    it(`finishes the claim when the confirming start lands mid-replacement: replacing is coming up, not gone`, async () => {
        const created = vi.fn().mockResolvedValue({});
        const poolDelete = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ id: `m7`, state: `replacing` }) },
            {
                match: (method, url) => method === `POST` && url.endsWith(`/machines/m7/start`),
                respond: () => json({ error: `failed_precondition: machine getting replaced, refusing to start` }, 412),
            },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m7`), respond: () => json({ id: `m7`, state: `replacing` }) },
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
        expect(result).toEqual({ appName: `intentic-sbx-pool-abc123`, region: `iad` });
        // No cold build was touched, and the hand-off committed: the reader owns the warm machine.
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(false);
        expect(created).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ machineId: `m7` }) }));
        expect(poolDelete).toHaveBeenCalledWith({ where: { id: `p1` } });
    });

    it(`ignores warm machines in the wrong region: the residency promise beats the fast path`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
        ]);
        const findMany = vi.fn().mockResolvedValue([]);
        const prisma = fakePrisma({ hostedMachine: { create: vi.fn().mockResolvedValue({}) }, hostedPoolMachine: { findMany } });
        await provisionHosted(prisma as never, config(), logger, { ...args, region: `arn` });
        // The pool was asked ONLY for the caller's region (and the current image): never "anything warm".
        expect(findMany).toHaveBeenCalledWith({
            where: { region: `arn`, state: `ready`, image: `ghcr.io/intentic/sandbox:stable` },
            orderBy: { createdAt: `asc` },
        });
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(true);
    });

    it(`falls back to a cold build when the claim stumbles: the reader is owed a machine, not a pool hit`, async () => {
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

    /* THE REGRESSION THIS PINS SHUT: the claim used to abandon the pool at the first refusal, so a machine Fly
     * had destroyed under its row cost a reader the whole cold build while a live warm machine sat unclaimed
     * beside it, in their own region, for every minute of the wait. Candidates come oldest-first, which is
     * exactly the order that hands out the longest-standing (most likely dead) row before any healthy one. */
    it(`tries the next warm machine when the first one is gone: one dead row must not cost a cold build`, async () => {
        const created = vi.fn().mockResolvedValue({});
        const poolDelete = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ error: `machine not found` }, 404) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m8`), respond: () => json({ id: `m8`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m8/start`), respond: () => json({ ok: true }) },
        ]);
        const second = { ...poolRow, id: `p2`, appName: `intentic-sbx-pool-def456`, machineId: `m8`, volumeId: `vol_8` };
        const prisma = fakePrisma({
            hostedMachine: { create: created },
            hostedPoolMachine: {
                findMany: vi.fn().mockResolvedValue([poolRow, second]),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                delete: poolDelete,
            },
        });
        const result = await provisionHosted(prisma as never, config(), logger, args);
        // The reader gets the SECOND warm machine, in seconds, and the cold path is never touched.
        expect(result).toEqual({ appName: `intentic-sbx-pool-def456`, region: `iad` });
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(false);
        expect(calls.some((entry) => entry.url.endsWith(`/machines/m8/start`))).toBe(true);
        expect(created).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ machineId: `m8` }) }));
        // Only the claimed row goes; the dead one stays `claimed` for the reconcile to collect.
        expect(poolDelete).toHaveBeenCalledTimes(1);
        expect(poolDelete).toHaveBeenCalledWith({ where: { id: `p2` } });
    });

    /* THE OTHER REASON A CLAIM'S ROW-WRITE FAILS, and the one that must NOT be read as "this warm machine is
     * bad". `sandboxId` is unique on HostedMachine, so a second provision for the same sandbox — a second tab,
     * a retried request, the desktop app beside the browser — loses its write. Walking to the next candidate
     * then brands, starts and strands EVERY ready machine in the region, one at a time, for a sandbox that
     * already has one: the pool the next arrival was going to claim is gone, and several machines are running
     * the same connect token until the reconcile collects them. */
    it(`abandons the claim when the sandbox was provisioned concurrently, instead of burning the region's stock`, async () => {
        const duplicate = new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (sandboxId)`, {
            code: `P2002`,
            clientVersion: `test`,
        });
        const created = vi.fn().mockRejectedValue(duplicate);
        const poolDelete = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ id: `m7`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7/start`), respond: () => json({ ok: true }) },
        ]);
        const second = { ...poolRow, id: `p2`, appName: `intentic-sbx-pool-def456`, machineId: `m8`, volumeId: `vol_8` };
        const claim = vi.fn().mockResolvedValue({ count: 1 });
        const prisma = fakePrisma({
            hostedMachine: {
                create: created,
                // What `alreadyProvisioned` asks: the winner's row is there, so this really is the race and
                // not an appName collision on one bad pool app.
                findUnique: vi.fn().mockResolvedValue({ id: `hm1` }),
            },
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow, second]), updateMany: claim, delete: poolDelete },
        });
        await expect(provisionHosted(prisma as never, config(), logger, args)).rejects.toBeInstanceOf(HostedAlreadyProvisioned);
        // ONE row branded, not every row in the region: the guarded `ready` → `claimed` win is the pool's
        // whole cost per attempt, and it must be paid exactly once however the row-write then fails.
        expect(claim).toHaveBeenCalledTimes(1);
        expect(claim).toHaveBeenCalledWith({ where: { id: `p1`, state: `ready` }, data: { state: `claimed` } });
        // The second warm machine is never touched, and no cold app is built either: exactly one machine is
        // spent on losing the race.
        expect(calls.some((entry) => entry.url.includes(`/machines/m8`))).toBe(false);
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(false);
        expect(created).toHaveBeenCalledTimes(1);
    });

    // The same race one step later: the cold path's own row-write loses. Its app is unambiguously its own (a
    // name collision would have failed at createApp), so it is taken back down and the winner's machine is the
    // answer — not a gateway error over a sandbox that has a machine.
    it(`takes its own cold app back down and reports the race when the row-write loses`, async () => {
        const duplicate = new Prisma.PrismaClientKnownRequestError(`Unique constraint failed`, { code: `P2002`, clientVersion: `test` });
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `app1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        const prisma = fakePrisma({
            hostedMachine: { create: vi.fn().mockRejectedValue(duplicate), findUnique: vi.fn().mockResolvedValue({ id: `hm1` }) },
        });
        await expect(provisionHosted(prisma as never, config(), logger, args)).rejects.toBeInstanceOf(HostedAlreadyProvisioned);
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(`/apps/intentic-sbx-`))).toBe(true);
    });
});

describe(`wakeHosted`, () => {
    it(`treats "already running" as success, the browser's daemon probe is the real verdict`, async () => {
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

/* THE SWEEP THAT CAUSED THE OUTAGE, and the three rules that keep it from causing another one.
 *
 * What it used to be: "every app under our prefix that our database cannot explain is litter". A Fly org is
 * shared by everything holding its credential, an app name carries no owner, and a second deployment (a
 * staging box, a laptop with a copy of the production env) therefore reads production's entire fleet as
 * litter. It destroyed all of it. The rows survived, pointing at machines that no longer existed, so every
 * affected person met a "start it over" button that could not, in principle, work. */
describe(`reapHostedOrphans`, () => {
    const appList = (...names: string[]) => ({
        match: (method: string, url: string) => method === `GET` && url.includes(`/apps?org_slug=`),
        respond: () => json({ apps: names.map((name) => ({ name })) }),
    });
    // Every app's machines answer from one table, keyed by the app named in the URL; an app missing from the
    // table has none, which is also how an empty app (volumes only) is modelled.
    const machinesOf = (byApp: Record<string, unknown[]>) => ({
        match: (method: string, url: string) => method === `GET` && (url.endsWith(`/machines`) || url.endsWith(`/volumes`)),
        respond: (url: string) => json(url.endsWith(`/volumes`) ? [] : (byApp[Object.keys(byApp).find((app) => url.includes(app)) ?? ``] ?? [])),
    });

    const deleteRoute = { match: (method: string) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) };
    const knownRows = fakePrisma({
        hostedMachine: { findMany: vi.fn().mockResolvedValue([{ appName: `intentic-sbx-live` }]) },
        hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([{ appName: `intentic-sbx-pool-warm1` }]) },
    });
    const deletedApps = (calls: { method: string; url: string }[]) => calls.filter((entry) => entry.method === `DELETE`).map((entry) => entry.url);

    it(`destroys only apps THIS platform stamped and no longer has a row for`, async () => {
        const calls = stubFetch([
            appList(
                `intentic-sbx-live`,
                `intentic-sbx-orphan`,
                `intentic-sbx-stranger`,
                `intentic-sbx-unstamped`,
                // A warm machine waiting in the pool is OURS ON PURPOSE: a reaper that eats the pool every
                // night would silently turn every claim back into a cold build.
                `intentic-sbx-pool-warm1`,
                `unrelated-app`,
            ),
            machinesOf({
                "intentic-sbx-orphan": [flyMachine({ platform: INSTANCE })],
                // Another deployment's machine, in the same org, under the same prefix. Destroying this is
                // the outage; leaving it standing is the entire point of the stamp.
                "intentic-sbx-stranger": [flyMachine({ platform: `deadbeefcafe` })],
                // No stamp at all: a machine from before this rule existed, or from a deployment that has not
                // been updated yet. Unprovable is not the same as unwanted, so it stands (the health sweep
                // reports it for a human instead).
                "intentic-sbx-unstamped": [flyMachine()],
            }),
            deleteRoute,
        ]);
        await reapHostedOrphans(knownRows as never, config(), logger);
        const deleted = deletedApps(calls);
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toContain(`intentic-sbx-orphan`);
        // Never even asked about: the prefix is still the jurisdiction, and a stranger's app outside it is
        // not this platform's business to read, let alone destroy.
        expect(calls.some((entry) => entry.url.includes(`unrelated-app`))).toBe(false);
    });

    /* A cold provision is app → volume → machine → row, minutes end to end, and for every one of them the app
     * exists with nothing in the database to vouch for it. A sweep landing in that window used to destroy the
     * machine of somebody who was, at that moment, watching it come up. */
    it(`leaves a young app alone: a provision in flight owns Fly resources before its row exists`, async () => {
        const calls = stubFetch([
            appList(`intentic-sbx-newborn`),
            machinesOf({ "intentic-sbx-newborn": [flyMachine({ platform: INSTANCE, ageMinutes: 2 })] }),
            deleteRoute,
        ]);
        await reapHostedOrphans(knownRows as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
    });

    // An app's volumes, with an age, so the two verdicts about an app holding no machine can be told apart.
    const volumesAged = (ageMinutes: number) => ({
        match: (method: string, url: string) => method === `GET` && url.endsWith(`/volumes`),
        respond: () => json([{ id: `vol_1`, created_at: new Date(Date.now() - ageMinutes * 60_000).toISOString() }]),
    });
    const noMachines = { match: (method: string, url: string) => method === `GET` && url.endsWith(`/machines`), respond: () => json([]) };

    /* AN APP WITH NOTHING IN IT, which used to stand forever. The stamp lives on a MACHINE, so an app holding
     * none has nothing to be proved by, and "unprovable" meant "leave it": the sweep logged it as unprovable
     * every night, the health watch counted it as a stranger every fifteen minutes, and the admins were mailed
     * about a fleet-loss that had not happened, on a schedule nothing could ever clear.
     *
     * Emptiness is its own evidence. A machine is the only thing that runs in an app, so an app without one is
     * running nothing and can cost nobody their sandbox; past the grace window with no row behind it, the only
     * things that produce this shape are a failed provision of ours and a failed provision of somebody
     * else's — litter under either reading. */
    it(`collects an app holding no machine at all, which nothing could ever prove was ours`, async () => {
        const calls = stubFetch([appList(`intentic-sbx-hollow`), noMachines, volumesAged(120), deleteRoute]);
        await reapHostedOrphans(knownRows as never, config(), logger);
        const deleted = deletedApps(calls);
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toContain(`intentic-sbx-hollow`);
    });

    // And the safety property that makes the rule above sound: the SAME empty shape, minutes old, is a cold
    // provision caught between its own steps (app → volume → machine → row) and must be left completely alone.
    it(`leaves an empty app whose volume was made minutes ago: that is a provision mid-flight`, async () => {
        const calls = stubFetch([appList(`intentic-sbx-mid-provision`), noMachines, volumesAged(2), deleteRoute]);
        await reapHostedOrphans(knownRows as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
    });

    /* THE CIRCUIT BREAKER. Every input this sweep has is "the database did not mention it", so every way the
     * database can be wrong (a replica on the wrong DSN, a restore in flight, migrations that have not run)
     * reads as "destroy everything" — and the sweep is most confident exactly when it is most wrong. */
    it(`refuses the whole pass when it would destroy an implausible share of the fleet`, async () => {
        const ours = Array.from({ length: 8 }, (_, index) => `intentic-sbx-${index}`);
        const calls = stubFetch([
            appList(...ours),
            machinesOf(Object.fromEntries(ours.map((app) => [app, [flyMachine({ platform: INSTANCE })]]))),
            deleteRoute,
        ]);
        // An empty database: nothing is known, so every app looks like litter.
        await reapHostedOrphans(fakePrisma({ hostedMachine: { findMany: vi.fn().mockResolvedValue([]) } }) as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
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
     * A member being shown a limit they do not have is the failure this shape exists to prevent, and the
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
        tunnelId: `abcdef012345`,
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

    it(`hostedProvision 404s when the lane is off: a platform without the config simply has no such route`, async () => {
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
        // `warm` is read off the app name (a pool claim keeps its pool name): the wait card's promise rides on it.
        expect(summary.hosted).toEqual({ region: `iad`, warm: true });
        expect(fetchSpy).toHaveLength(0);
    });

    /* Idempotence again, for the case the check above cannot cover: the two calls OVERLAP. `existing` is a read
     * with no lock behind it, so a second tab, a retried request or the desktop app beside the browser both get
     * past it and one of them loses its row-write. The reader who lost is owed the machine that exists, not a
     * gateway error about a sandbox that is, by then, perfectly hosted. */
    it(`hostedProvision answers with the winner's machine when a concurrent provision beat it`, async () => {
        const calls = stubFetch([
            {
                match: (method, url) => method === `GET` && url.endsWith(`/api/v2/namespaces`),
                respond: () => json([{ namespaceToken: `ns-1`, name: `public`, open: true }]),
            },
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `app1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        const duplicate = new Prisma.PrismaClientKnownRequestError(`Unique constraint failed`, { code: `P2002`, clientVersion: `test` });
        const prisma = fakePrisma({
            sandbox: {
                findFirst: vi.fn().mockResolvedValue(ownedRow),
                findUniqueOrThrow: vi.fn().mockResolvedValue({ ...ownedRow, hosted: { region: `iad`, appName: `intentic-sbx-pool-abc123` } }),
                update: vi.fn().mockResolvedValue(ownedRow),
            },
            hostedMachine: {
                // Null for the route's own pre-flight read, then the winner's row for the question
                // `provisionHosted` asks once its write is refused.
                findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: `hm1` }),
                count: vi.fn().mockResolvedValue(0),
                create: vi.fn().mockRejectedValue(duplicate),
            },
        });
        // `headers` is the region pick's only input (region.ts reads cf-ipcountry): absent means "cannot tell",
        // which is the US default, exactly as it is for a self-hosted platform with no Cloudflare in front.
        const context = routeContext({ prisma, headers: new Headers() });
        const summary = await call(sandboxRoutes.hostedProvision, { sandboxId: `s1` }, { context });
        // The winner's machine, and the loser's own half-built app taken back down behind it.
        expect(summary.hosted).toEqual({ region: `iad`, warm: true });
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(`/apps/intentic-sbx-`))).toBe(true);
    });

    // The lane switch: a sandbox nobody ever connected to can hand its machine back. One that HAS connected
    // cannot: that is a workspace with files on it, and destroying its machine belongs to the delete dialog.
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
        // Once, to match the single provider DELETE above. Releasing twice would leave the row gone and the
        // second call racing whatever claimed the name next, and "it was called" cannot see that.
        expect(machineDelete).toHaveBeenCalledTimes(1);

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
            skip_launch?: boolean;
        };
        expect(update.config.image).toBe(`ghcr.io/intentic/sandbox:stable`);
        expect(update.config.mounts).toEqual([{ volume: `vol_1`, path: `/data` }]);
        expect(update.config.env[`CONNECT_TOKEN`]).toBe(`tok`);
        expect(update.config.env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        // The replacement carries the launch; the wake that follows only confirms it (fly.ts).
        expect(update.skip_launch).toBeUndefined();
        expect(calls.findIndex((entry) => entry.url.endsWith(`/machines/m1`))).toBeLessThan(
            calls.findIndex((entry) => entry.url.endsWith(`/machines/m1/start`)),
        );
    });

    /* THE BUTTON THAT COULD NOT WORK. A machine destroyed provider-side leaves a row pointing at nothing, so
     * every refresh answers 404 and the setup card's one recovery failed forever, for exactly the people most
     * likely to press it. There is nothing on a machine that does not exist to preserve, so the honest
     * recovery is a new machine on the same sandbox: same name, same address, same sharing, empty disk. */
    it(`hostedRestart builds a replacement when the provider says the machine is gone`, async () => {
        const machineCreate = vi.fn().mockResolvedValue({});
        const rowDelete = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1/stop`), respond: () => json({ error: `app not found` }, 404) },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m1`), respond: () => json({ error: `app not found` }, 404) },
            {
                match: (method, url) => method === `GET` && url.endsWith(`/api/v2/namespaces`),
                respond: () => json([{ namespaceToken: `ns-1`, name: `public`, open: true }]),
            },
            // The refresh of the machine that is gone…
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ error: `app not found` }, 404) },
            // …and the cold build that replaces it.
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a2` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_2` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m2`, state: `created` }) },
        ]);
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(ownedRow) },
            hostedMachine: {
                findUnique: vi.fn().mockResolvedValue({ id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, volumeId: `vol_1`, region: `iad`, wokeAt: null }),
                create: machineCreate,
                delete: rowDelete,
                update: vi.fn().mockResolvedValue({}),
            },
        });
        expect(await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ ok: true });
        // The dead row goes first: `sandboxId` is unique on that table, so the replacement could not be
        // written beside it, and a machine with no row is what the reaper collects.
        expect(rowDelete).toHaveBeenCalledWith({ where: { id: `h1` } });
        expect(machineCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ machineId: `m2`, sandboxId: `s1` }) }));
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(true);
    });

    // The other half of the same rule: a refusal that is NOT "there is no such machine" must never be read as
    // one, or a bad minute at the provider would throw away a working machine and its disk.
    it(`hostedRestart destroys nothing when the provider merely refuses`, async () => {
        const rowDelete = vi.fn();
        stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1/stop`), respond: () => json({ ok: true }) },
            {
                match: (method, url) => method === `GET` && url.endsWith(`/api/v2/namespaces`),
                respond: () => json([{ namespaceToken: `ns-1`, name: `public`, open: true }]),
            },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m1`), respond: () => json({ id: `m1`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ error: `host unavailable` }, 500) },
        ]);
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(ownedRow) },
            hostedMachine: {
                findUnique: vi.fn().mockResolvedValue({ id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, volumeId: `vol_1`, region: `iad`, wokeAt: null }),
                delete: rowDelete,
                update: vi.fn().mockResolvedValue({}),
            },
        });
        await expect(call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).rejects.toMatchObject({
            code: `BAD_GATEWAY`,
        });
        expect(rowDelete).not.toHaveBeenCalled();
    });

    // The wait card cannot narrate what the route will not say: a destroyed machine reads as `gone`, never as
    // the `unknown` that means "keep waiting, we cannot see".
    it(`hostedStatus answers gone when the provider says there is no such machine`, async () => {
        stubFetch([{ match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ error: `app not found` }, 404) }]);
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue({ appName: `intentic-sbx-a`, machineId: `m1` }) },
        });
        expect(await call(sandboxRoutes.hostedStatus, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ machine: `gone` });
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
        // The access query admits owner OR accepted member: the OR is the contract here.
        expect(findFirst.mock.calls[0]?.[0]?.where?.OR).toHaveLength(2);
    });
});
