import { Prisma } from "@intentic/prisma";
import { call, ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrpcContext } from "../../context.js";
import type { Config } from "../../config.js";
import { sandboxRoutes } from "../sandbox.routes.js";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { hostedEnabled, hostedInstanceId, provisionHosted, reapHostedOrphans, wakeHosted } from "./hosted.js";
import { HostedAlreadyProvisioned } from "./hosted-cleanup.js";
import { AT_CAPACITY_MESSAGE, forgetProviderCapacity, HostedAtCapacity } from "./hosted-capacity.js";
import { forgetHostedImage } from "./build/hosted-image.js";
import { testIngressConfig } from "../../testing.js";

vi.mock(`./hosted-app-lock.js`, async () => ({ withHostedAppLock: (await import(`../../testing.js`)).fakeHostedAppLock }));

/* The settle between a machine's config update and its start (hosted.ts SETTLE_MS) is half a second of real
 * time in production, polled up to sixty times. Here the wait is a no-op: every case that crosses it is about
 * WHICH provider states count as settled and what is asked of Fly in each, never about how long settling
 * takes, and the six that crossed it in real time were most of this package's test wall-clock. */
vi.mock("node:timers/promises", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:timers/promises")>()),
    setTimeout: async () => undefined,
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

// Enabled hosted config fixture; each case overrides only the fields it's testing.
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
            // No ceiling by default; capacity tests set this to the number under test.
            maxMachines: 0,
        },
        hostedPlan: { compEmails: ``, stripeSecretKey: ``, stripePriceId: `` },
        ...over,
    }) as unknown as Config;

/* Every model the hosted routes touch, stubbed to the harmless answer, with the case's own overrides on top.
 * The defaults matter: the hour meter reads membership (absent ⇒ not a member ⇒ metered) and the month's
 * usage (absent ⇒ nothing spent) on paths whose SUBJECT is something else entirely, and a fixture that
 * omitted them would fail those tests for a reason none of them are about. */
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>>) => {
    const prisma = {
        hostedPlan: { findUnique: vi.fn().mockResolvedValue(null) },
        hostedUsage: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
        /* Two shapes. The array form settles what the model calls already returned. The callback form is the
         * row write under the owner's slot lock (hosted.ts withHostedSlot): it runs against this same fake, the
         * advisory lock below is a no-op, and the slot count answers whatever the case set `hostedMachine.count`
         * to — 0 unless a case is about the count. */
        $transaction: vi.fn((work: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
            typeof work === `function` ? work(prisma) : Promise.all(work),
        ),
        $executeRaw: vi.fn().mockResolvedValue(0),
        $queryRaw: vi.fn().mockResolvedValue([]),
        ...overrides,
        hostedCleanup: {
            findUnique: vi.fn().mockResolvedValue({}),
            create: vi.fn().mockResolvedValue({}),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            upsert: vi.fn().mockResolvedValue({}),
            findMany: vi.fn().mockResolvedValue([]),
            ...overrides[`hostedCleanup`],
        },
        // Empty pool by default so tests not about the pool exercise the cold path.
        hostedPoolMachine: {
            findMany: vi.fn().mockResolvedValue([]),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            delete: vi.fn().mockResolvedValue({}),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            ...overrides[`hostedPoolMachine`],
        },
        // `findMany` is the hour meter's live read (an owner's open stretches): none open unless a test says so;
        // `count` is the owner's slot use at the row write, none unless a test says so.
        hostedMachine: {
            update: vi.fn().mockResolvedValue({}),
            findUnique: vi.fn().mockResolvedValue(null),
            findMany: vi.fn().mockResolvedValue([]),
            count: vi.fn().mockResolvedValue(0),
            ...overrides[`hostedMachine`],
        },
        // The claim adopts the pool machine's identity onto the sandbox row inside the hand-off transaction, and
        // the slot write reads the row's owner first.
        sandbox: {
            update: vi.fn().mockResolvedValue({}),
            findUnique: vi.fn().mockResolvedValue({ tokenDigest: sha256Hex(`t0k3n`) }),
            findUniqueOrThrow: vi.fn().mockResolvedValue({ ownerId: `u1` }),
            ...overrides[`sandbox`],
        },
    };
    return prisma as unknown as OrpcContext[`prisma`];
};

// `respond` receives the URL so a route can answer per app; the orphan sweep asks each app about its own machines.
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

// Fake Fly machine mirroring two real behaviours: while replacing, reads return `replacing` and starts get 412; an
// update leaves a stopped machine stopped until started. `replacingFor` sets how many reads report `replacing` first.
const settlingMachine = (id: string, options: { replacingFor?: number } = {}) => {
    let replacing = options.replacingFor ?? 0;
    let started = false;
    return {
        read: () => {
            if (replacing > 0) {
                replacing -= 1;
                return json({ id, state: `replacing` });
            }
            return json({ id, state: started ? `started` : `stopped` });
        },
        start: () => {
            if (replacing > 0) {
                return json({ error: `failed_precondition: machine getting replaced, refusing to start` }, 412);
            }
            started = true;
            return json({ ok: true });
        },
        get started() {
            return started;
        },
    };
};

// This deployment's stamp, derived from its own API URL.
const INSTANCE = hostedInstanceId(config());
// Fly machine as the orphan sweep reads it: whose it is, and when it was made.
const flyMachine = (over: { platform?: string; ageMinutes?: number; role?: string } = {}) => ({
    id: `m1`,
    state: `stopped`,
    created_at: new Date(Date.now() - (over.ageMinutes ?? 120) * 60_000).toISOString(),
    config: { metadata: over.platform === undefined ? {} : { intentic_role: over.role ?? `warm`, intentic_platform: over.platform } },
});

afterEach(() => {
    vi.unstubAllGlobals();
    // Clears module-level capacity-refusal memory so tests don't leak state between cases.
    forgetProviderCapacity();
    // Likewise the resolved-image memo: a case that stubs a registry would otherwise hand its digest to every
    // later case, which reads as those cases claiming stock they should have stepped over.
    forgetHostedImage();
});

describe(`hostedEnabled`, () => {
    it(`needs BOTH the Fly credential and the reachability fabric: machines without it boot to nothing`, () => {
        expect(hostedEnabled(config())).toBe(true);
        expect(hostedEnabled(config({ hosted: { ...config().hosted, flyApiToken: `` } }))).toBe(false);
        expect(hostedEnabled(config({ ingress: { ...testIngressConfig, signingKey: `` } }))).toBe(false);
    });
});

// Identifies a deployment by its API URL and database address, not credentials, so a copy of the same env file pointed
// at a different database counts as a different deployment.
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

    it(`differs for the same database name reached at a different address`, () => {
        const production = hostedInstanceId(withDb(`postgresql://app:app@db:5432/intentic`));
        const staging = hostedInstanceId(withDb(`postgresql://app:app@db:5432/intentic`, { api: { url: `https://api.staging.test` } }));
        expect(staging).not.toBe(production);
    });

    it(`ignores the database's credentials, so the same server under two passwords is one deployment`, () => {
        expect(hostedInstanceId(withDb(`postgresql://app:one@db:5432/intentic`))).toBe(
            hostedInstanceId(withDb(`postgresql://app:two@db:5432/intentic`)),
        );
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
        ownerEmail: `owner@example.com`,
        // In production this comes from the caller's country; region.test.ts covers the pick.
        region: `iad`,
    };
    // Hostname a machine answers under, derived from its connect token.
    const hostnameOf = (token: string): string => `sandbox-${sandboxIdFromToken(token)}.sbx.test`;

    it(`creates app → volume → machine and stamps the row; the env is the contract's vocabulary`, async () => {
        const created = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
        ]);
        const result = await provisionHosted(fakePrisma({ hostedMachine: { create: created } }) as never, config(), logger, args);
        expect(result).toEqual({ appName: `intentic-sbx-${sandboxIdFromToken(`t0k3n`)}`, region: `iad`, warm: false });
        const machine = calls.find((entry) => entry.url.includes(`/machines`))?.body as {
            config: {
                env: Record<string, string>;
                mounts: { volume: string }[];
                metadata: Record<string, string>;
                services: { internal_port: number }[];
                checks: Record<string, { headers: { name: string; values: string[] }[] }>;
            };
        };
        expect(machine.config.mounts).toEqual([{ volume: `vol_1`, path: `/data` }]);
        // Platform stamp lets this deployment's reaper distinguish its own machines from others sharing the org.
        // The owner rides with it so the Fly console can answer "whose machine is this?" without a database.
        expect(machine.config.metadata).toEqual({
            intentic_role: `sandbox`,
            intentic_sandbox: `s1`,
            intentic_platform: INSTANCE,
            intentic_owner: `owner@example.com`,
        });
        expect(machine.config.env[`CONNECT_TOKEN`]).toBe(`t0k3n`);
        expect(machine.config.env[`SANDBOX_PUBLIC_URL`]).toBe(`https://${hostnameOf(`t0k3n`)}`);
        // Hosted machines are reached via the edge replaying to their app; no tunnel grant or edge to dial.
        expect(machine.config.env[`SANDBOX_GRANT`]).toBeUndefined();
        expect(machine.config.env[`INGRESS_URL`]).toBeUndefined();
        // Front door is declared instead, checked under the replay hostname.
        expect(machine.config.services.map((service) => service.internal_port)).toEqual([5173]);
        expect(machine.config.checks[`front-door`]?.headers).toEqual([{ name: `Host`, values: [hostnameOf(`t0k3n`)] }]);
        expect(machine.config.env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        expect(machine.config.env[`IDLE_STOP_MINUTES`]).toBe(`20`);
        expect(machine.config.env[`SANDBOX_VM`]).toBe(`1`);
        // `wokeAt` opens the hour meter's first stretch at provisioning, not at first connection.
        expect(created).toHaveBeenCalledWith({
            data: {
                sandboxId: `s1`,
                appName: result.appName,
                machineId: `m1`,
                volumeId: `vol_1`,
                region: `iad`,
                warm: false,
                wokeAt: expect.any(Date),
            },
        });
    });

    it(`a failure after the app exists deletes the app again so a retry starts clean`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ error: `internal error` }, 500) },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        await expect(provisionHosted(fakePrisma({ hostedMachine: { create: vi.fn() } }) as never, config(), logger, args)).rejects.toThrow(
            /internal error/,
        );
        expect(calls.some((entry) => entry.method === `DELETE`)).toBe(true);
    });

    it(`refuses without touching the provider when the fleet is at its ceiling`, async () => {
        const fetchSpy = stubFetch([]);
        const full = fakePrisma({
            hostedMachine: { create: vi.fn(), count: vi.fn().mockResolvedValue(100) },
            hostedPoolMachine: { count: vi.fn().mockResolvedValue(0) },
            hostedBuild: { count: vi.fn().mockResolvedValue(0) },
        });
        await expect(
            provisionHosted(full as never, config({ hosted: { ...config().hosted, maxMachines: 100 } }), logger, args),
        ).rejects.toBeInstanceOf(HostedAtCapacity);
        expect(fetchSpy).toHaveLength(0);
    });

    it(`reads the provider's own "no machines left" as the same refusal, and still cleans up`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            {
                match: (method, url) => method === `POST` && url.includes(`/machines`),
                respond: () => json({ error: `failed to launch VM: You have reached the maximum number of machines for this app` }, 422),
            },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        await expect(provisionHosted(fakePrisma({ hostedMachine: { create: vi.fn() } }) as never, config(), logger, args)).rejects.toBeInstanceOf(
            HostedAtCapacity,
        );
        expect(calls.some((entry) => entry.method === `DELETE`)).toBe(true);
    });

    // Pool machine named after a token minted when it was built; secrets.key is empty in these fixtures, so the stored
    // token is the plaintext one.
    const POOL_TOKEN = `p00l-t0k3n`;
    const POOL_APP = `intentic-sbx-${sandboxIdFromToken(POOL_TOKEN)}`;
    const SECOND_TOKEN = `p00l-t0k3n-2`;
    const SECOND_APP = `intentic-sbx-${sandboxIdFromToken(SECOND_TOKEN)}`;
    // What the registry reports for the configured tag in these tests, and the pinned name that follows from it.
    const POOL_DIGEST = `sha256:a2efc11a3e6b517557ad0b46cbae6f2b6270b632d93e09cb8b816c7ad8487125`;
    const PINNED_IMAGE = `ghcr.io/intentic/sandbox@${POOL_DIGEST}`;
    const poolRow = {
        id: `p1`,
        appName: POOL_APP,
        machineId: `m7`,
        volumeId: `vol_7`,
        region: `iad`,
        image: `ghcr.io/intentic/sandbox:stable`,
        state: `ready`,
        token: POOL_TOKEN,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    it(`claims a warm machine when one is waiting: brands it, starts it, and opens the meter at claim`, async () => {
        const created = vi.fn().mockResolvedValue({});
        const poolDelete = vi.fn().mockResolvedValue({});
        const adopt = vi.fn().mockResolvedValue({});
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const machine = settlingMachine(`m7`);
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ id: `m7`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7/start`), respond: () => machine.start() },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m7`), respond: () => machine.read() },
        ]);
        const prisma = fakePrisma({
            hostedMachine: { create: created },
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow]), updateMany, delete: poolDelete },
            sandbox: { update: adopt },
        });
        const result = await provisionHosted(prisma as never, config(), logger, args);
        expect(result).toEqual({ appName: POOL_APP, region: `iad`, warm: true });
        // Guarded update (state: `ready`) is what stops two claimers taking the same machine.
        expect(updateMany).toHaveBeenCalledWith({ where: { id: `p1`, state: `ready` }, data: { state: `claimed` } });
        // Identity is written before the machine can run the sandbox; the prewarm flag is cleared here too.
        const update = calls.find((entry) => entry.url.endsWith(`/machines/m7`))?.body as {
            config: { env: Record<string, string>; init?: unknown; mounts: { volume: string }[]; metadata: Record<string, string> };
            skip_launch?: boolean;
        };
        // Stamp flips with the identity in the same call; it's the only way to tell this machine left the pool.
        // Warm stock carries no owner, so gaining one is also the moment the machine stops being nobody's.
        expect(update.config.metadata).toEqual({
            intentic_role: `sandbox`,
            intentic_sandbox: `s1`,
            intentic_platform: INSTANCE,
            intentic_owner: `owner@example.com`,
        });
        // App was named for its build-time token, and the edge replays `sandbox-<id>` straight to app `<prefix>-<id>`:
        // this machine's identity must become the sandbox it now serves.
        expect(update.config.env[`CONNECT_TOKEN`]).toBe(POOL_TOKEN);
        expect(update.config.env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        expect(update.config.env[`SANDBOX_PUBLIC_URL`]).toBe(`https://${hostnameOf(POOL_TOKEN)}`);
        // Row is updated in the same transaction as the hand-off: token, digest and id together.
        expect(adopt).toHaveBeenCalledWith({
            where: { id: `s1` },
            data: { token: POOL_TOKEN, tokenDigest: sha256Hex(POOL_TOKEN), tunnelId: sandboxIdFromToken(POOL_TOKEN) },
        });
        expect(update.config.init).toBeUndefined();
        expect(update.config.mounts).toEqual([{ volume: `vol_7`, path: `/data` }]);
        // The branding call is the launch itself; holding it back with skip_launch and starting separately races Fly's
        // `replacing` state.
        expect(update.skip_launch).toBeUndefined();
        expect(calls.some((entry) => entry.url.endsWith(`/machines/m7/start`))).toBe(true);
        // An update leaves a stopped machine stopped; the claim must confirm the start landed, not just that it was
        // requested.
        expect(machine.started).toBe(true);
        // User's clock starts at claim, not at the pool's earlier no-op boot.
        expect(created).toHaveBeenCalledWith({
            data: {
                sandboxId: `s1`,
                appName: POOL_APP,
                machineId: `m7`,
                volumeId: `vol_7`,
                region: `iad`,
                warm: true,
                wokeAt: expect.any(Date),
            },
        });
        expect(poolDelete).toHaveBeenCalledWith({ where: { id: `p1` } });
    });

    it(`waits out the replacement, then starts the machine: replacing is neither a dead row nor a running one`, async () => {
        const created = vi.fn().mockResolvedValue({});
        const poolDelete = vi.fn().mockResolvedValue({});
        const machine = settlingMachine(`m7`, { replacingFor: 2 });
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ id: `m7`, state: `replacing` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7/start`), respond: () => machine.start() },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m7`), respond: () => machine.read() },
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
        expect(result).toEqual({ appName: POOL_APP, region: `iad`, warm: true });
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(false);
        expect(created).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ machineId: `m7` }) }));
        expect(poolDelete).toHaveBeenCalledWith({ where: { id: `p1` } });
        expect(machine.started).toBe(true);
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
        expect(findMany).toHaveBeenCalledWith({
            // Excludes pool rows with no token: such a row names no app the edge could reach.
            // The IMAGE is no longer part of this query: a row now stores the digest its machine actually holds,
            // which only a registry round trip can name, and an empty pool must not pay for one to learn it is
            // empty. The claim filters the rows it got back against the resolved digest instead.
            where: { region: `arn`, state: `ready`, NOT: { token: `` } },
            orderBy: { createdAt: `asc` },
        });
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(true);
    });

    it(`falls back to a cold build when the claim stumbles: the reader is owed a machine, not a pool hit`, async () => {
        const created = vi.fn().mockResolvedValue({});
        const poolDelete = vi.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ error: `host unavailable` }, 500) },
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
        expect(result.appName).not.toBe(POOL_APP);
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(true);
        // Won row stays `claimed`, not put back: a half-branded machine already carries this sandbox's tokens, so
        // reconcile collects it instead.
        expect(poolDelete).not.toHaveBeenCalled();
    });

    /* THE CLAIM MUST NOT CHANGE WHAT THE MACHINE IS HOLDING, and this is the assertion that says so.
     *
     * A warm machine is worth having because the sandbox image is already on its disk. The claim replaces its
     * config to give it an identity, and that config names an image — so if it names the configured TAG, Fly
     * re-resolves the tag, and after a re-push that is a different digest and the machine must pull before it
     * can start. `startAfterUpdate` allows thirty seconds; a pull is minutes. Measured in production: one
     * re-push of `sandbox:stable`, then four claims, then four "did not start after its config was replaced"
     * and four users waiting out the cold build the pool exists to avoid. Naming the row's own digest is the
     * whole fix, so it is pinned here rather than left to read correctly. */
    it(`boots the digest the warm machine already holds, never the configured tag`, async () => {
        const machine = settlingMachine(`m7`);
        const calls = stubFetch([
            {
                match: (_method, url) => url.includes(`/v2/intentic/sandbox/manifests/`),
                respond: () => new Response(null, { status: 200, headers: { "docker-content-digest": POOL_DIGEST } }),
            },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ id: `m7`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7/start`), respond: () => machine.start() },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m7`), respond: () => machine.read() },
        ]);
        const prisma = fakePrisma({
            hostedMachine: { create: vi.fn().mockResolvedValue({}) },
            hostedPoolMachine: {
                findMany: vi.fn().mockResolvedValue([{ ...poolRow, image: PINNED_IMAGE }]),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                delete: vi.fn().mockResolvedValue({}),
            },
        });
        const result = await provisionHosted(prisma as never, config(), logger, args);
        expect(result.warm).toBe(true);
        const booted = calls
            .filter((entry) => entry.method === `POST` && entry.url.endsWith(`/machines/m7`))
            .map((entry) => (entry.body as { config: { image: string } }).config.image);
        expect(booted).toEqual([PINNED_IMAGE]);
    });

    // The other half: stock whose digest the tag no longer names is not stock. Adopting it is what used to cost
    // the pull, so the claim steps over it and reconcile destroys it on its own tick.
    it(`steps over a warm machine on a superseded image and builds cold instead`, async () => {
        const calls = stubFetch([
            {
                match: (_method, url) => url.includes(`/v2/intentic/sandbox/manifests/`),
                respond: () => new Response(null, { status: 200, headers: { "docker-content-digest": POOL_DIGEST } }),
            },
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
        ]);
        const poolDelete = vi.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            hostedMachine: { create: vi.fn().mockResolvedValue({}) },
            hostedPoolMachine: {
                findMany: vi
                    .fn()
                    .mockResolvedValue([
                        { ...poolRow, image: `ghcr.io/intentic/sandbox@sha256:0000000000000000000000000000000000000000000000000000000000000000` },
                    ]),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                delete: poolDelete,
            },
        });
        const result = await provisionHosted(prisma as never, config(), logger, args);
        expect(result.warm).toBe(false);
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(true);
        // Never touched: not claimed, not destroyed here. Reconcile owns drifted stock.
        expect(calls.some((entry) => entry.url.endsWith(`/machines/m7`))).toBe(false);
        expect(poolDelete).not.toHaveBeenCalled();
    });

    // Candidates are tried oldest-first, so the most likely-dead row is tried before any healthy one.
    it(`tries the next warm machine when the first one is gone: one dead row must not cost a cold build`, async () => {
        const created = vi.fn().mockResolvedValue({});
        const poolDelete = vi.fn().mockResolvedValue({});
        const secondMachine = settlingMachine(`m8`);
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ error: `machine not found` }, 404) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m8`), respond: () => json({ id: `m8`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m8/start`), respond: () => secondMachine.start() },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m8`), respond: () => secondMachine.read() },
        ]);
        const second = { ...poolRow, id: `p2`, appName: SECOND_APP, machineId: `m8`, volumeId: `vol_8`, token: SECOND_TOKEN };
        const prisma = fakePrisma({
            hostedMachine: { create: created },
            hostedPoolMachine: {
                findMany: vi.fn().mockResolvedValue([poolRow, second]),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                delete: poolDelete,
            },
        });
        const result = await provisionHosted(prisma as never, config(), logger, args);
        expect(result).toEqual({ appName: SECOND_APP, region: `iad`, warm: true });
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(false);
        expect(calls.some((entry) => entry.url.endsWith(`/machines/m8/start`))).toBe(true);
        expect(created).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ machineId: `m8` }) }));
        // Dead row stays `claimed` for reconcile; only the claimed p2 row is removed here.
        expect(poolDelete).toHaveBeenCalledTimes(1);
        expect(poolDelete).toHaveBeenCalledWith({ where: { id: `p2` } });
    });

    // A duplicate write on `sandboxId` means the sandbox already has a machine, not that the warm machine is bad;
    // treating it as the latter would strand every ready machine in the region.
    it(`abandons the claim when the sandbox was provisioned concurrently, instead of burning the region's stock`, async () => {
        const duplicate = new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (sandboxId)`, {
            code: `P2002`,
            clientVersion: `test`,
        });
        const created = vi.fn().mockRejectedValue(duplicate);
        const poolDelete = vi.fn().mockResolvedValue({});
        const machine = settlingMachine(`m7`);
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ id: `m7`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7/start`), respond: () => machine.start() },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m7`), respond: () => machine.read() },
        ]);
        const second = { ...poolRow, id: `p2`, appName: SECOND_APP, machineId: `m8`, volumeId: `vol_8`, token: SECOND_TOKEN };
        const claim = vi.fn().mockResolvedValue({ count: 1 });
        const prisma = fakePrisma({
            hostedMachine: {
                create: created,
                // Winner's row already exists: this is the concurrent-provision race, not an appName collision.
                findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: `hm1` }),
            },
            hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([poolRow, second]), updateMany: claim, delete: poolDelete },
        });
        await expect(provisionHosted(prisma as never, config(), logger, args)).rejects.toBeInstanceOf(HostedAlreadyProvisioned);
        // Exactly one row is branded per attempt: the guarded ready-to-claimed win must be paid once regardless of how
        // the write then fails.
        expect(claim).toHaveBeenCalledTimes(1);
        expect(claim).toHaveBeenCalledWith({ where: { id: `p1`, state: `ready` }, data: { state: `claimed` } });
        expect(calls.some((entry) => entry.url.includes(`/machines/m8`))).toBe(false);
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(false);
        expect(created).toHaveBeenCalledTimes(1);
    });

    // Its own app is unambiguous here: a name collision would already have failed at createApp.
    it(`takes its own cold app back down and reports the race when the row-write loses`, async () => {
        const duplicate = new Prisma.PrismaClientKnownRequestError(`Unique constraint failed`, { code: `P2002`, clientVersion: `test` });
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `app1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        const prisma = fakePrisma({
            hostedMachine: {
                create: vi.fn().mockRejectedValue(duplicate),
                findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: `hm1` }),
            },
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

// A Fly org is shared by every deployment holding its credential, and an app name alone proves no owner, so reaping
// must key off this platform's own stamp, not an unexplained app under the prefix.
describe(`reapHostedOrphans`, () => {
    const appList = (...names: string[]) => ({
        match: (method: string, url: string) => method === `GET` && url.includes(`/apps?org_slug=`),
        respond: () => json({ apps: names.map((name) => ({ name })) }),
    });
    // Machines keyed by app name; an app missing from the table has none (also models a volume-only app).
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
                // Warm pool machine is ours on purpose; reaping it nightly would turn every claim into a cold build.
                `intentic-sbx-pool-warm1`,
                `unrelated-app`,
            ),
            machinesOf({
                "intentic-sbx-orphan": [flyMachine({ platform: INSTANCE })],
                // Different platform stamp: another deployment's machine in the same org/prefix must be left standing.
                "intentic-sbx-stranger": [flyMachine({ platform: `deadbeefcafe` })],
                // No stamp: predates the rule or an unupdated deployment; left standing, flagged by the health sweep
                // instead.
                "intentic-sbx-unstamped": [flyMachine()],
            }),
            deleteRoute,
        ]);
        await reapHostedOrphans(knownRows as never, config(), logger);
        const deleted = deletedApps(calls);
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toContain(`intentic-sbx-orphan`);
        // Prefix is the jurisdiction: an app outside it is never even queried.
        expect(calls.some((entry) => entry.url.includes(`unrelated-app`))).toBe(false);
    });

    it(`reads an app holding only a builder as its own: a build stamp proves ownership like any other`, async () => {
        const calls = stubFetch([
            appList(`intentic-sbx-leftover-builder`),
            machinesOf({ "intentic-sbx-leftover-builder": [flyMachine({ platform: INSTANCE, role: `build` })] }),
            deleteRoute,
        ]);
        await reapHostedOrphans(knownRows as never, config(), logger);
        const deleted = deletedApps(calls);
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toContain(`intentic-sbx-leftover-builder`);
    });

    it(`leaves a young app alone: a provision in flight owns Fly resources before its row exists`, async () => {
        const calls = stubFetch([
            appList(`intentic-sbx-newborn`),
            machinesOf({ "intentic-sbx-newborn": [flyMachine({ platform: INSTANCE, ageMinutes: 2 })] }),
            deleteRoute,
        ]);
        await reapHostedOrphans(knownRows as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
    });

    // App's volumes with an age, to distinguish the two verdicts for an app holding no machine.
    const volumesAged = (ageMinutes: number) => ({
        match: (method: string, url: string) => method === `GET` && url.endsWith(`/volumes`),
        respond: () => json([{ id: `vol_1`, created_at: new Date(Date.now() - ageMinutes * 60_000).toISOString() }]),
    });
    const noMachines = { match: (method: string, url: string) => method === `GET` && url.endsWith(`/machines`), respond: () => json([]) };

    // Past the grace window, an empty app can only be a failed provision, ours or someone else's, so it's collected
    // either way.
    it(`collects an app holding no machine at all, which nothing could ever prove was ours`, async () => {
        const calls = stubFetch([appList(`intentic-sbx-hollow`), noMachines, volumesAged(120), deleteRoute]);
        await reapHostedOrphans(knownRows as never, config(), logger);
        const deleted = deletedApps(calls);
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toContain(`intentic-sbx-hollow`);
    });

    it(`leaves an empty app whose volume was made minutes ago: that is a provision mid-flight`, async () => {
        const calls = stubFetch([appList(`intentic-sbx-mid-provision`), noMachines, volumesAged(2), deleteRoute]);
        await reapHostedOrphans(knownRows as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
    });

    // Every signal here is "the database didn't mention it", so a wrong database (bad replica, restore in flight, unrun
    // migration) reads as "destroy everything", exactly when the sweep is most confident and most wrong.
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
    // hostedMachine.count answers two different questions per request: no `where` means the whole fleet (the ceiling);
    // a `where` means one owner's allowance. This stub only answers the fleet question.
    const fleetOf = (machines: number) =>
        vi.fn().mockImplementation((query?: { where?: unknown }) => Promise.resolve(query?.where === undefined ? machines : 0));

    // `headers` feeds the region pick and the offer's stock-region check; empty means "cannot tell", the same as a
    // self-hosted platform with no Cloudflare in front.
    const routeContext = (over?: Partial<OrpcContext>): OrpcContext =>
        ({ prisma: fakePrisma({}), config: config(), user, logger, headers: new Headers(), ...over }) as OrpcContext;

    it(`hostedOffer answers disabled/0 when the lane is off, and the remaining allowance when on`, async () => {
        const off = await call(sandboxRoutes.hostedOffer, undefined, {
            context: routeContext({ config: config({ hosted: { ...config().hosted, flyApiToken: `` } }) }),
        });
        expect(off).toEqual({ enabled: false, remaining: 0 });
        const on = await call(sandboxRoutes.hostedOffer, undefined, {
            context: routeContext({ prisma: fakePrisma({ hostedMachine: { count: vi.fn().mockResolvedValue(0) } }) }),
        });
        // Ceiling is surfaced before any of it is spent, so the offer card doesn't say "free" and correct itself later.
        expect(on).toEqual({ enabled: true, remaining: 1, hours: { allowance: 40, remaining: 40 } });
    });

    it(`hostedOffer tells a member nothing about hours, because none apply to them`, async () => {
        const member = fakePrisma({
            hostedMachine: { count: vi.fn().mockResolvedValue(0) },
            // Plan row: status and how many hosted sandboxes it covers.
            hostedPlan: { findUnique: vi.fn().mockResolvedValue({ status: `active`, quantity: 1 }) },
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
        // Where the plan is actually for sale, the same owner is told they're on it (`plan: true`), distinguishing this
        // from the uncapped case above.
        const selling = routeContext({
            prisma: member,
            config: config({ hostedPlan: { ...config().hostedPlan, stripeSecretKey: `sk`, stripePriceId: `price` } }),
        });
        expect(await call(sandboxRoutes.hostedOffer, undefined, { context: selling })).toEqual({ enabled: true, remaining: 1, plan: true });
    });

    // PAYMENT_REQUIRED specifically, so the editor can offer membership without parsing the message.
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

    it(`wake starts a member's machine however much of the month has been used`, async () => {
        stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ ok: true }) }]);
        const spentMember = fakePrisma({
            sandbox: {
                findFirst: vi
                    .fn()
                    .mockResolvedValue({ id: `s1`, ownerId: `u1`, hosted: { id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null } }),
            },
            hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 40 * 60 }) },
            hostedPlan: { findUnique: vi.fn().mockResolvedValue({ status: `active` }) },
        });
        expect(await call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: spentMember }) })).toEqual({ ok: true });
    });

    // Baseline sandbox row: ordinary creation, tunnel already claimed.
    const ownedRow = {
        id: `s1`,
        name: `mine`,
        image: null,
        ownerId: `u1`,
        token: `t0k3n`,
        tunnelId: `abcdef012345`,
        daemonUrl: null,
        lastSeenAt: null,
        setupCodeClaimedAt: null,
        setupReport: null,
    };

    it(`hostedProvision refuses over-quota before touching any provider`, async () => {
        const fetchSpy = stubFetch([]);
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(1) },
        });
        await expect(
            call(sandboxRoutes.hostedProvision, { sandboxId: `s1`, token: `t0k3n` }, { context: routeContext({ prisma }) }),
        ).rejects.toMatchObject({
            code: `BAD_REQUEST`,
        });
        expect(fetchSpy).toHaveLength(0);
    });

    // `remaining` here is this account's own untouched allowance, separate from the fleet-wide ceiling being tested.
    it(`hostedOffer says the lane is full when the fleet is at its ceiling with no stock left`, async () => {
        const full = fakePrisma({
            hostedMachine: { count: fleetOf(100) },
            hostedPoolMachine: { count: vi.fn().mockResolvedValue(0) },
            hostedBuild: { count: vi.fn().mockResolvedValue(0) },
        });
        const context = routeContext({ prisma: full, config: config({ hosted: { ...config().hosted, maxMachines: 100 } }) });
        expect(await call(sandboxRoutes.hostedOffer, undefined, { context })).toEqual({
            enabled: true,
            remaining: 1,
            full: true,
            hours: { allowance: 40, remaining: 40 },
        });
    });

    // Claiming warm stock creates nothing new, so it still counts as a machine to give even at the fleet ceiling.
    it(`hostedOffer keeps offering while there is warm stock the caller could claim`, async () => {
        const stocked = fakePrisma({
            hostedMachine: { count: fleetOf(98) },
            // Both machines are claimable, so the count reads the same whether it asks about the whole pool or just
            // ready stock.
            hostedPoolMachine: { count: vi.fn().mockResolvedValue(2) },
            hostedBuild: { count: vi.fn().mockResolvedValue(0) },
        });
        const context = routeContext({ prisma: stocked, config: config({ hosted: { ...config().hosted, maxMachines: 100 } }) });
        expect(await call(sandboxRoutes.hostedOffer, undefined, { context })).toEqual({
            enabled: true,
            remaining: 1,
            hours: { allowance: 40, remaining: 40 },
        });
    });

    // Not a gateway error: the editor can't tell a retryable fault from a capacity refusal it should treat differently.
    it(`hostedProvision answers a full fleet as unavailable, in words a person can act on`, async () => {
        const fetchSpy = stubFetch([]);
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue(null), count: fleetOf(100) },
            hostedPoolMachine: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
            hostedBuild: { count: vi.fn().mockResolvedValue(0) },
        });
        const context = routeContext({ prisma, config: config({ hosted: { ...config().hosted, maxMachines: 100 } }) });
        await expect(call(sandboxRoutes.hostedProvision, { sandboxId: `s1`, token: `t0k3n` }, { context })).rejects.toMatchObject({
            code: `SERVICE_UNAVAILABLE`,
            message: AT_CAPACITY_MESSAGE,
        });
        expect(fetchSpy).toHaveLength(0);
    });

    it(`hostedProvision 404s when the lane is off: a platform without the config simply has no such route`, async () => {
        await expect(
            call(
                sandboxRoutes.hostedProvision,
                { sandboxId: `s1`, token: `t0k3n` },
                { context: routeContext({ config: config({ hosted: { ...config().hosted, flyOrg: `` } }) }) },
            ),
        ).rejects.toMatchObject({ code: `NOT_FOUND` });
    });

    it(`hostedProvision answers with the sandbox it already hosts, without creating anything`, async () => {
        const fetchSpy = stubFetch([]);
        const prisma = fakePrisma({
            sandbox: {
                findFirst: vi.fn().mockResolvedValue(ownedRow),
                findUniqueOrThrow: vi.fn().mockResolvedValue({ ...ownedRow, hosted: { region: `iad`, warm: true } }),
            },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue({ appName: `intentic-sbx-pool-abc123`, machineId: `m1` }), count: vi.fn() },
        });
        const summary = await call(sandboxRoutes.hostedProvision, { sandboxId: `s1`, token: `t0k3n` }, { context: routeContext({ prisma }) });
        // `warm` is read off the app name: a pool claim keeps its pool-assigned name.
        expect(summary.hosted).toEqual({ region: `iad`, warm: true });
        expect(fetchSpy).toHaveLength(0);
    });

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
                findUniqueOrThrow: vi.fn().mockResolvedValue({ ...ownedRow, hosted: { region: `iad`, warm: true } }),
                update: vi.fn().mockResolvedValue(ownedRow),
            },
            hostedMachine: {
                // Null for the route's own pre-flight read, then the winner's row once the write is refused.
                findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ id: `hm1` }),
                count: vi.fn().mockResolvedValue(0),
                create: vi.fn().mockRejectedValue(duplicate),
            },
        });
        const context = routeContext({ prisma, headers: new Headers() });
        const summary = await call(sandboxRoutes.hostedProvision, { sandboxId: `s1`, token: `t0k3n` }, { context });
        expect(summary.hosted).toEqual({ region: `iad`, warm: true });
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(`/apps/intentic-sbx-`))).toBe(true);
    });

    it.each([null, new Date()])(`hostedRelease durably cancels setup with lastSeenAt %s`, async (lastSeenAt) => {
        const fetch = vi.fn();
        vi.stubGlobal(`fetch`, fetch);
        const machineDelete = vi.fn().mockResolvedValue({});
        const upsert = vi.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            sandbox: {
                findFirst: vi.fn().mockResolvedValue({ ...ownedRow, lastSeenAt }),
                findUniqueOrThrow: vi
                    .fn()
                    .mockResolvedValueOnce({ ...ownedRow, lastSeenAt, hosted: { id: `h1`, appName: `intentic-sbx-a`, wokeAt: null } })
                    .mockResolvedValue({ ...ownedRow, hosted: null }),
            },
            hostedCleanup: { upsert },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue({ appName: `intentic-sbx-a` }), delete: machineDelete },
        });
        const summary = await call(sandboxRoutes.hostedRelease, { sandboxId: `s1` }, { context: routeContext({ prisma }) });
        expect(summary.hosted).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
        expect(upsert).toHaveBeenCalledExactlyOnceWith({ where: { appName: `intentic-sbx-a` }, create: { appName: `intentic-sbx-a` }, update: {} });
        expect(machineDelete).toHaveBeenCalledExactlyOnceWith({ where: { id: `h1` } });
    });

    it(`hostedRestart refreshes the current image onto the existing volume before starting`, async () => {
        // Restart replaces the config too, so it must observe the machine running rather than merely asking it to.
        const machine = settlingMachine(`m1`);
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1/stop`), respond: () => json({ ok: true }) },
            {
                match: (method, url) => method === `GET` && url.endsWith(`/api/v2/namespaces`),
                respond: () => json([{ namespaceToken: `ns-1`, name: `public`, open: true }]),
            },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ id: `m1`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1/start`), respond: () => machine.start() },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m1`), respond: () => machine.read() },
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
        expect(update.config.env[`CONNECT_TOKEN`]).toBe(`t0k3n`);
        expect(update.config.env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        // The replacement itself carries the launch; the wake that follows only confirms it landed (fly.ts).
        expect(update.skip_launch).toBeUndefined();
        expect(calls.findIndex((entry) => entry.url.endsWith(`/machines/m1`))).toBeLessThan(
            calls.findIndex((entry) => entry.url.endsWith(`/machines/m1/start`)),
        );
    });

    // Same sandbox identity (name, address, sharing) on a fresh, empty disk; nothing on a destroyed machine is worth
    // preserving.
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
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ error: `app not found` }, 404) },
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a2` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_2` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m2`, state: `created` }) },
        ]);
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(ownedRow) },
            hostedMachine: {
                findUnique: vi
                    .fn()
                    .mockResolvedValueOnce({ id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, volumeId: `vol_1`, region: `iad`, wokeAt: null })
                    .mockResolvedValue(null),
                create: machineCreate,
                delete: rowDelete,
                update: vi.fn().mockResolvedValue({}),
            },
        });
        expect(await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ ok: true });
        // Dead row is deleted first: `sandboxId` is unique, so the replacement can't be written beside it.
        expect(rowDelete).toHaveBeenCalledWith({ where: { id: `h1` } });
        expect(machineCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ machineId: `m2`, sandboxId: `s1` }) }));
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(true);
    });

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
                findUnique: vi
                    .fn()
                    .mockResolvedValue({ id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, volumeId: `vol_1`, region: `iad`, wokeAt: null }),
                delete: rowDelete,
                update: vi.fn().mockResolvedValue({}),
            },
        });
        await expect(call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).rejects.toMatchObject({
            code: `BAD_GATEWAY`,
        });
        expect(rowDelete).not.toHaveBeenCalled();
    });

    // Distinguish from `unknown`, which means keep waiting; `gone` must only mean actually destroyed.
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

    it(`wake drops the row and the sandbox's dead address when the provider has no such machine`, async () => {
        stubFetch([{ match: () => true, respond: () => json({ error: `machine not found` }, 404) }]);
        const written: unknown[] = [];
        const prisma = fakePrisma({
            sandbox: {
                findFirst: vi
                    .fn()
                    .mockResolvedValue({ id: `s1`, ownerId: `u1`, hosted: { id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null } }),
                update: vi.fn((args: unknown) => {
                    written.push(args);
                    return Promise.resolve({});
                }),
            },
            hostedMachine: {
                delete: vi.fn((args: unknown) => {
                    written.push(args);
                    return Promise.resolve({});
                }),
            },
        });
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).rejects.toMatchObject({
            code: `NOT_FOUND`,
        });
        // Row is dropped so hostedOffer stops counting a machine that no longer exists against the owner's allowance.
        expect(written).toContainEqual({ where: { id: `h1` } });
        // Address is cleared so the browser reads "not connected" and offers setup, instead of reconnecting forever.
        expect(written).toContainEqual({ where: { id: `s1` }, data: { daemonUrl: null } });
    });

    // A refusal is not evidence of anything; treating it as "gone" would reset every hosted sandbox on one bad minute.
    it(`wake keeps the row when the provider merely refuses`, async () => {
        stubFetch([{ match: () => true, respond: () => json({ error: `host unavailable` }, 500) }]);
        const remove = vi.fn();
        const prisma = fakePrisma({
            sandbox: {
                findFirst: vi
                    .fn()
                    .mockResolvedValue({ id: `s1`, ownerId: `u1`, hosted: { id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null } }),
                update: vi.fn().mockResolvedValue({}),
            },
            hostedMachine: { delete: remove },
        });
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).rejects.toMatchObject({
            code: `BAD_GATEWAY`,
        });
        expect(remove).not.toHaveBeenCalled();
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
        // Access query admits owner OR accepted member; the OR is the contract under test.
        expect(findFirst.mock.calls[0]?.[0]?.where?.OR).toHaveLength(2);
    });
});
