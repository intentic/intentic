import { generateKeyPairSync } from "node:crypto";
import { FREE_TIER, type HostedTier, PAID_TIERS } from "@intentic/constants";
import { FLY_VOLUME_PATH } from "@intentic/sandbox-run/fly";
import { Prisma } from "@intentic/prisma";
import { call, ORPCError } from "@orpc/server";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { OrpcContext } from "../../context.js";
import { configSchema, type Config } from "../../config.js";
import { sandboxRoutes } from "../sandbox.routes.js";
import { hostOwnerId, mintReachabilityGrant, verifyReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { publicKeyPemOf } from "@intentic/sandbox-contract/owner-ticket";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import {
    hostedEnabled,
    hostedInstanceId,
    provisionHosted,
    reapHostedOrphans,
    refreshHosted,
    startAfterUpdate,
    wakeHosted,
    type HostedProvisionArgs,
} from "./hosted.js";
import { HostedAlreadyProvisioned } from "./hosted-cleanup.js";
import { hostedShapeFor } from "./hosted-shape.js";
import { AT_CAPACITY_MESSAGE, forgetProviderCapacity, HostedAtCapacity } from "./hosted-capacity.js";
import { forgetHostedImage } from "./build/hosted-image.js";
import { HostedImageKept, HostedMachineBusy, STATE_PROBE_ENV } from "./gate/state-gate.js";
import { CLEAR_STATE_PLAN, type FakeFly, type FakeFlyCall, type FakeFlyMachine, installFakeFly } from "@intentic/testing/fly-fake";
import { fakeHostedAppLock, testIngressConfig } from "../../testing.js";
import { createApp } from "../../app.js";
import { RECOVERY_WINDOW_MS } from "../../durations.js";
import * as timersPromisesOriginal from "node:timers/promises";

jest.mock(`./hosted-app-lock.js`, () => ({ withHostedAppLock: fakeHostedAppLock }));

/* The settle between a machine's config update and its start (hosted.ts SETTLE_MS) is half a second of real time in production, polled up to sixty times. */
jest.mock("node:timers/promises", () => ({
    ...timersPromisesOriginal,
    setTimeout: async () => undefined,
}));

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;

// Enabled hosted config fixture; each case overrides only the fields it's testing.
const config = (over?: Record<string, unknown>): Config =>
    ({
        webOrigin: `https://app.test`,
        google: { clientId: `gcid` },
        api: { url: `https://api.test`, trustedIpHeader: `` },
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
            // The newcomer ramp and the same-source caps off: this suite's arithmetic is the month's and the slots'.
            newAccountDays: 0,
            newAccountHours: 0,
            provisionsPerIpPerDay: 0,
            provisionsPerDomainPerDay: 0,
            idleDays: 21,
            idleWarnDays: 14,
            poolSize: 1,
            // No ceiling by default; capacity tests set this to the number under test.
            maxMachines: 0,
        },
        hostedPlan: { compEmails: ``, stripeSecretKey: ``, stripePrices: `` },
        ...over,
    }) as unknown as Config;

// The cheapest rung on sale, for the one case that needs this platform to be selling something at all.
const ENTRY = PAID_TIERS[0] as HostedTier;
const PAID = ENTRY;

/* Every model the hosted routes touch, stubbed to the harmless answer, with the case's own overrides on top. */
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof jest.fn>>>) => {
    const prisma = {
        hostedPlan: { findUnique: jest.fn().mockResolvedValue(null) },
        hostedUsage: {
            findUnique: jest.fn().mockResolvedValue(null),
            upsert: jest.fn().mockResolvedValue({}),
            aggregate: jest.fn().mockResolvedValue({ _sum: { minutes: null } }),
        },
        // In good standing, and the provision ledger accepts every row.
        user: { findUnique: jest.fn().mockResolvedValue({ hostedSuspendedAt: null, hostedSuspendedReason: null }) },
        hostedProvision: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        /* Two shapes. */
        $transaction: jest.fn((work: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
            typeof work === `function` ? work(prisma) : Promise.all(work),
        ),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
        ...overrides,
        hostedCleanup: {
            findUnique: jest.fn().mockResolvedValue({}),
            create: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            upsert: jest.fn().mockResolvedValue({}),
            findMany: jest.fn().mockResolvedValue([]),
            ...overrides[`hostedCleanup`],
        },
        // The reaper reads this for apps held back from a deleted sandbox; empty unless a test is about one.
        sandboxTrash: {
            findMany: jest.fn().mockResolvedValue([]),
            ...overrides[`sandboxTrash`],
        },
        // Empty pool by default so tests not about the pool exercise the cold path.
        hostedPoolMachine: {
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            delete: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            ...overrides[`hostedPoolMachine`],
        },
        // `findMany` is the hour meter's live read (an owner's open stretches): none open unless a test says so;
        // `count` is the owner's slot use at the row write, none unless a test says so.
        hostedMachine: {
            update: jest.fn().mockResolvedValue({}),
            findUnique: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
            ...overrides[`hostedMachine`],
        },
        // The claim adopts the pool machine's identity onto the sandbox row inside the hand-off transaction, and
        // the slot write reads the row's owner first.
        sandbox: {
            update: jest.fn().mockResolvedValue({}),
            findUnique: jest.fn().mockResolvedValue({ tokenDigest: sha256Hex(`t0k3n`) }),
            findUniqueOrThrow: jest.fn().mockResolvedValue({ ownerId: `u1` }),
            ...overrides[`sandbox`],
        },
    };
    return prisma as unknown as OrpcContext[`prisma`];
};

// `respond` receives the URL so a route can answer per app; the orphan sweep asks each app about its own machines.
const stubFetch = (routes: { match: (method: string, url: string) => boolean; respond: (url: string) => Response }[]) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    stubGlobal(`fetch`, (url: URL | string, init?: RequestInit): Promise<Response> => {
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

// Fake Fly machine mirroring three real behaviours, each read off a live fleet's machine events: while replacing,
// reads return `replacing` and starts get 412; the replacement then leaves a NEW VM record that reads `created` before
// it settles; and an update leaves a stopped machine stopped until something starts it. `replacingFor` and `createdFor`
// set how many reads report each. The `created` window is the one this fake used to skip, which is exactly the window
// production kept losing machines in.
const settlingMachine = (id: string, options: { replacingFor?: number; createdFor?: number } = {}) => {
    let replacing = options.replacingFor ?? 0;
    let created = options.createdFor ?? 1;
    let started = false;
    return {
        read: () => {
            if (replacing > 0) {
                replacing -= 1;
                return json({ id, state: `replacing` });
            }
            if (!started && created > 0) {
                created -= 1;
                return json({ id, state: `created` });
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
    unstubAllGlobals();
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

/* A shape is spread straight into machine rows (provisionHosted below, hosted-migrate.ts commitMigration), so it has
 * to be the four columns and nothing else. Handing a rung back whole type-checks — a rung IS a shape — and then fails
 * at the write on `name`, `priceUsd` and the rest, which no type can catch and every migration would hit. */
describe(`hostedShapeFor`, () => {
    it(`answers a paid rung with the four shape fields and none of the rung's own`, () => {
        expect(hostedShapeFor(config(), PAID.id)).toEqual({
            cpuKind: PAID.cpuKind,
            cpus: PAID.cpus,
            memoryMb: PAID.memoryMb,
            volumeGb: PAID.volumeGb,
        });
    });

    it(`answers the free rung with the operator's own numbers, since they run the hardware`, () => {
        const deployment = config({ hosted: { ...config().hosted, cpus: 4, memoryMb: 8192, volumeGb: 30 } });
        expect(hostedShapeFor(deployment, FREE_TIER.id)).toEqual({ cpuKind: FREE_TIER.cpuKind, cpus: 4, memoryMb: 8192, volumeGb: 30 });
    });
});

describe(`provisionHosted`, () => {
    const args = {
        sandboxId: `s1`,
        connectToken: `t0k3n`,
        ownerEmail: `owner@example.com`,
        // In production this comes from the caller's country; region.test.ts covers the pick.
        region: `iad`,
        // The rung an arrival with no plan lands on, and the only one warm stock can serve.
        tier: FREE_TIER.id,
    };
    // Hostname a machine answers under, derived from its connect token.
    const hostnameOf = (token: string): string => `sandbox-${sandboxIdFromToken(token)}.sbx.test`;

    it(`creates app → volume → machine and stamps the row; the env is the contract's vocabulary`, async () => {
        const created = jest.fn().mockResolvedValue({});
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
                mounts: { volume: string; path: string }[];
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
        // Hosted machines dial the edge's tunnel like every sandbox, presenting a grant for their own id.
        expect(verifyReachabilityGrant(publicKeyPemOf(testIngressConfig.signingKey), machine.config.env[`SANDBOX_GRANT`] ?? ``)?.sandboxId).toBe(
            sandboxIdFromToken(`t0k3n`),
        );
        expect(machine.config.env[`INGRESS_URL`]).toBe(testIngressConfig.url);
        // The front door stays, checked under the replay hostname, for as long as the edge sits behind Fly's proxy.
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
                // The row states the machine it made, rather than leaving a reader to look the rung up later. Read
                // from the same place the provisioner reads it, since this deployment overrides the free rung's CPUs.
                tier: FREE_TIER.id,
                ...hostedShapeFor(config(), FREE_TIER.id),
            },
        });
    });

    it(`a failure after the app exists deletes the app again so a retry starts clean`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ error: `internal error` }, 500) },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) },
        ]);
        await expect(provisionHosted(fakePrisma({ hostedMachine: { create: jest.fn() } }) as never, config(), logger, args)).rejects.toThrow(
            /internal error/,
        );
        expect(calls.some((entry) => entry.method === `DELETE`)).toBe(true);
    });

    it(`refuses without touching the provider when the fleet is at its ceiling`, async () => {
        const fetchSpy = stubFetch([]);
        const full = fakePrisma({
            hostedMachine: { create: jest.fn(), count: jest.fn().mockResolvedValue(100) },
            hostedPoolMachine: { count: jest.fn().mockResolvedValue(0) },
            hostedBuild: { count: jest.fn().mockResolvedValue(0) },
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
        await expect(provisionHosted(fakePrisma({ hostedMachine: { create: jest.fn() } }) as never, config(), logger, args)).rejects.toBeInstanceOf(
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
        const created = jest.fn().mockResolvedValue({});
        const poolDelete = jest.fn().mockResolvedValue({});
        const adopt = jest.fn().mockResolvedValue({});
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const machine = settlingMachine(`m7`);
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ id: `m7`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7/start`), respond: () => machine.start() },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m7`), respond: () => machine.read() },
        ]);
        const prisma = fakePrisma({
            hostedMachine: { create: created },
            hostedPoolMachine: { findMany: jest.fn().mockResolvedValue([poolRow]), updateMany, delete: poolDelete },
            sandbox: { update: adopt },
        });
        const result = await provisionHosted(prisma as never, config(), logger, args);
        expect(result).toEqual({ appName: POOL_APP, region: `iad`, warm: true });
        // Guarded update (state: `ready`) is what stops two claimers taking the same machine.
        expect(updateMany).toHaveBeenCalledWith({ where: { id: `p1`, state: `ready` }, data: { state: `claimed` } });
        // Identity is written before the machine can run the sandbox; the prewarm flag is cleared here too.
        const update = calls.find((entry) => entry.url.endsWith(`/machines/m7`))?.body as {
            config: { env: Record<string, string>; init?: unknown; mounts: { volume: string; path: string }[]; metadata: Record<string, string> };
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
                // The row states the machine it made, rather than leaving a reader to look the rung up later. Read
                // from the same place the provisioner reads it, since this deployment overrides the free rung's CPUs.
                tier: FREE_TIER.id,
                ...hostedShapeFor(config(), FREE_TIER.id),
            },
        });
        expect(poolDelete).toHaveBeenCalledWith({ where: { id: `p1` } });
    });

    it(`waits out the replacement, then starts the machine: replacing is neither a dead row nor a running one`, async () => {
        const created = jest.fn().mockResolvedValue({});
        const poolDelete = jest.fn().mockResolvedValue({});
        const machine = settlingMachine(`m7`, { replacingFor: 2 });
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ id: `m7`, state: `replacing` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7/start`), respond: () => machine.start() },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m7`), respond: () => machine.read() },
        ]);
        const prisma = fakePrisma({
            hostedMachine: { create: created },
            hostedPoolMachine: {
                findMany: jest.fn().mockResolvedValue([poolRow]),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
        const findMany = jest.fn().mockResolvedValue([]);
        const prisma = fakePrisma({ hostedMachine: { create: jest.fn().mockResolvedValue({}) }, hostedPoolMachine: { findMany } });
        await provisionHosted(prisma as never, config(), logger, { ...args, region: `arn` });
        expect(findMany).toHaveBeenCalledWith({
            // No image filter: a row holds its machine's digest, which an empty pool must not pay a registry round trip to name.
            where: { region: `arn`, state: `ready` },
            orderBy: { createdAt: `asc` },
        });
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(true);
    });

    it(`falls back to a cold build when the claim stumbles: the reader is owed a machine, not a pool hit`, async () => {
        const created = jest.fn().mockResolvedValue({});
        const poolDelete = jest.fn().mockResolvedValue({});
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ error: `host unavailable` }, 500) },
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
        ]);
        const prisma = fakePrisma({
            hostedMachine: { create: created },
            hostedPoolMachine: {
                findMany: jest.fn().mockResolvedValue([poolRow]),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

    /* THE CLAIM MUST NOT CHANGE WHAT THE MACHINE IS HOLDING, and this is the assertion that says so. */
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
            hostedMachine: { create: jest.fn().mockResolvedValue({}) },
            hostedPoolMachine: {
                findMany: jest.fn().mockResolvedValue([{ ...poolRow, image: PINNED_IMAGE }]),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                delete: jest.fn().mockResolvedValue({}),
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
        const poolDelete = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            hostedMachine: { create: jest.fn().mockResolvedValue({}) },
            hostedPoolMachine: {
                findMany: jest.fn().mockResolvedValue([
                    { ...poolRow, image: `ghcr.io/intentic/sandbox@sha256:0000000000000000000000000000000000000000000000000000000000000000` },
                ]),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
        const created = jest.fn().mockResolvedValue({});
        const poolDelete = jest.fn().mockResolvedValue({});
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
                findMany: jest.fn().mockResolvedValue([poolRow, second]),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
        const created = jest.fn().mockRejectedValue(duplicate);
        const poolDelete = jest.fn().mockResolvedValue({});
        const machine = settlingMachine(`m7`);
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7`), respond: () => json({ id: `m7`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m7/start`), respond: () => machine.start() },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m7`), respond: () => machine.read() },
        ]);
        const second = { ...poolRow, id: `p2`, appName: SECOND_APP, machineId: `m8`, volumeId: `vol_8`, token: SECOND_TOKEN };
        const claim = jest.fn().mockResolvedValue({ count: 1 });
        const prisma = fakePrisma({
            hostedMachine: {
                create: created,
                // Winner's row already exists: this is the concurrent-provision race, not an appName collision.
                findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: `hm1` }),
            },
            hostedPoolMachine: { findMany: jest.fn().mockResolvedValue([poolRow, second]), updateMany: claim, delete: poolDelete },
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
                create: jest.fn().mockRejectedValue(duplicate),
                findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: `hm1` }),
            },
        });
        await expect(provisionHosted(prisma as never, config(), logger, args)).rejects.toBeInstanceOf(HostedAlreadyProvisioned);
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(`/apps/intentic-sbx-`))).toBe(true);
    });
});

/* THE SECOND WHERE A CLAIMED MACHINE LOOKS LIKE IT IS RUNNING AND IS NOT. */
describe(`startAfterUpdate`, () => {
    // Replacing a stopped machine's config gives it a new VM record reading `created`, which settles back to
    // `stopped`; the machine has not been asked to run. Taking that for a running one returned this loop with no
    // start ever issued, and every reader downstream — the claim, the row, the wait card — believed it.
    it(`starts a machine that reads created after the replacement, rather than taking the word for a running one`, async () => {
        const machine = settlingMachine(`m1`);
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => machine.start() },
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => machine.read() },
        ]);
        await expect(startAfterUpdate(config(), { appName: `intentic-sbx-a`, machineId: `m1` })).resolves.toBeUndefined();
        expect(calls.filter((entry) => entry.url.endsWith(`/start`))).toHaveLength(1);
        expect(machine.started).toBe(true);
    });

    // The whole point of confirming: a machine that never runs must fail the claim rather than be handed over.
    it(`gives up on a machine that never runs, instead of handing over one that is merely created`, async () => {
        stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ ok: true }) },
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ id: `m1`, state: `created` }) },
        ]);
        await expect(startAfterUpdate(config(), { appName: `intentic-sbx-a`, machineId: `m1` })).rejects.toThrow(/did not start/);
    });
});

// A hosted machine's row as the wake reads it: the free rung's guest, stock image, no overlay.
const WAKE_TARGET = {
    appName: `intentic-sbx-a`,
    machineId: `m1`,
    volumeId: `vol1`,
    cpuKind: `shared`,
    cpus: 2,
    memoryMb: 4096,
    volumeGb: 10,
    image: null,
    environmentHash: null,
};
const WAKE_TOKEN = `t0k3n`;
const wakeArgs = (): HostedProvisionArgs => ({
    sandboxId: `s1`,
    connectToken: WAKE_TOKEN,
    ownerEmail: `owner@example.com`,
    region: `iad`,
    tier: FREE_TIER.id,
});
// The digest the machine was provisioned on, and the one `stable` resolves to today.
const PINNED = `ghcr.io/intentic/sandbox@sha256:${`a`.repeat(64)}`;
const STABLE_DIGEST = `sha256:${`b`.repeat(64)}`;
// The environment a hosted machine was given before 71dbfb7145: everything but the tunnel's pair.
const PRE_TUNNEL_ENV = {
    GOOGLE_CLIENT_ID: `gcid`,
    CONNECT_TOKEN: WAKE_TOKEN,
    OWNER_EMAIL: `owner@example.com`,
    WEB_ORIGIN: `https://app.test`,
    SANDBOX_PUBLIC_URL: `https://sandbox-${sandboxIdFromToken(WAKE_TOKEN)}.sbx.test`,
    PLATFORM_URL: `https://api.test`,
    IDLE_STOP_MINUTES: `20`,
};
const currentTunnelEnv = () => ({
    ...PRE_TUNNEL_ENV,
    INGRESS_URL: testIngressConfig.url,
    SANDBOX_GRANT: mintReachabilityGrant(testIngressConfig.signingKey, sandboxIdFromToken(WAKE_TOKEN) ?? ``, Date.now()),
});

// A hosted machine on the shared Fly fake, configured with `env` on the digest it was provisioned on; the registry answers
// today's `stable` beside it. The fake models what the state gate does around a config change: the probe's exec, its
// stop, the start after.
const configuredFly = (env: Record<string, string>, state = `stopped`, beside: (url: string) => Response | undefined = () => undefined) => {
    const fly = installFakeFly((name, value) => stubGlobal(name, value), {
        passThrough: (input) => {
            const url = input instanceof Request ? input.url : String(input);
            const answer = url.includes(`/v2/intentic/sandbox/manifests/`)
                ? new Response(null, { status: 200, headers: { "docker-content-digest": STABLE_DIGEST } })
                : beside(url);
            return answer === undefined ? Promise.reject(new Error(`unexpected fetch: ${url}`)) : Promise.resolve(answer);
        },
    });
    fly.apps.add(`intentic-sbx-a`);
    const at = new Date().toISOString();
    fly.machines.set(`m1`, { id: `m1`, app: `intentic-sbx-a`, region: `iad`, state, config: { image: PINNED, env }, createdAt: at, updatedAt: at });
    return fly;
};
// Every config replacement, the probe's included.
const updatesIn = (fly: FakeFly): FakeFlyCall[] => fly.called(`POST`, `/machines/m1`);
// The config the machine ends on: the last one written.
// SAFETY: the fake holds the config fly.ts last wrote, which is a FlyMachineConfig.
const finalConfigOf = (fly: FakeFly) =>
    fly.machines.get(`m1`)?.config as { image: string; env: Record<string, string>; guest: Record<string, unknown>; mounts: unknown[] };
const runningIn = (fly: FakeFly): boolean => fly.machines.get(`m1`)?.state === `started`;
const machineIn = (fly: FakeFly): FakeFlyMachine => {
    const machine = fly.machines.get(`m1`);
    if (machine === undefined) {
        throw new Error(`the fake holds no machine m1`);
    }
    return machine;
};
// The row a restart reads: a stock machine on the free rung.
const RESTART_ROW = { id: `h1`, sandboxId: `s1`, appName: `intentic-sbx-a`, machineId: `m1`, volumeId: `vol_1`, region: `iad`, wokeAt: null, tier: `free` };

describe(`wakeHosted`, () => {
    it(`treats "already running" as success, the browser's daemon probe is the real verdict`, async () => {
        stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ error: `machine is started` }, 422) },
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ id: `m1`, state: `started` }) },
        ]);
        await expect(wakeHosted(config(), WAKE_TARGET)).resolves.toBe(false);
    });

    it(`propagates a refusal on a machine that is genuinely not coming up`, async () => {
        stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ error: `host unavailable` }, 500) },
            { match: (method, url) => method === `GET` && url.includes(`/machines/`), respond: () => json({ id: `m1`, state: `stopped` }) },
        ]);
        await expect(wakeHosted(config(), WAKE_TARGET)).rejects.toThrow(/host unavailable/);
    });

    it(`starts a machine whose tunnel environment is current, and writes no config`, async () => {
        const fly = configuredFly(currentTunnelEnv());
        await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).resolves.toBe(false);
        expect(updatesIn(fly)).toHaveLength(0);
        expect(fly.called(`POST`, `/machines/m1/start`)).toHaveLength(1);
    });

    // The row's guest and volume stay; the image is today's stock digest, since one this old predates the front.
    it(`re-applies the config of a machine missing the tunnel's pair, onto today's stock digest`, async () => {
        const fly = configuredFly(PRE_TUNNEL_ENV);
        await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).resolves.toBe(true);
        expect(finalConfigOf(fly)).toMatchObject({
            image: `ghcr.io/intentic/sandbox@${STABLE_DIGEST}`,
            guest: { cpu_kind: `shared`, cpus: 2, memory_mb: 4096 },
            mounts: [{ volume: `vol1`, path: FLY_VOLUME_PATH }],
        });
        const { env } = finalConfigOf(fly);
        expect(env[`INGRESS_URL`]).toBe(testIngressConfig.url);
        expect(verifyReachabilityGrant(publicKeyPemOf(testIngressConfig.signingKey), env[`SANDBOX_GRANT`] ?? ``)?.sandboxId).toBe(
            sandboxIdFromToken(WAKE_TOKEN),
        );
        expect(env[STATE_PROBE_ENV]).toBeUndefined();
        // A new digest is an image change: its planner was asked first, in a probe, and the machine runs the real config.
        expect(fly.called(`POST`, `/machines/m1/exec`)).toHaveLength(1);
        expect(runningIn(fly)).toBe(true);
    });

    // Stale is as bad as missing: an edge that moved, or a grant signed by a key the edge no longer holds.
    it.each([
        [`an edge address that moved`, () => ({ ...currentTunnelEnv(), INGRESS_URL: `https://old-ingress.sbx.test` })],
        [
            `a grant another key signed`,
            () => ({
                ...currentTunnelEnv(),
                SANDBOX_GRANT: mintReachabilityGrant(
                    generateKeyPairSync(`ed25519`).privateKey.export({ type: `pkcs8`, format: `pem` }).toString(),
                    sandboxIdFromToken(WAKE_TOKEN) ?? ``,
                    Date.now(),
                ),
            }),
        ],
        [`a grant for another sandbox`, () => ({ ...currentTunnelEnv(), SANDBOX_GRANT: mintReachabilityGrant(testIngressConfig.signingKey, `0123456789ab`, Date.now()) })],
    ])(`re-applies the config of a machine with %s`, async (_, env) => {
        const fly = configuredFly(env());
        await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).resolves.toBe(true);
        expect(finalConfigOf(fly).env[`INGRESS_URL`]).toBe(testIngressConfig.url);
    });

    // A running machine the browser cannot reach is the case this is for: the replacement restarts it with the tunnel.
    it(`re-applies the config of a running machine that lacks the grant, and confirms it runs again`, async () => {
        const fly = configuredFly(PRE_TUNNEL_ENV, `started`);
        await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).resolves.toBe(true);
        // The probe's config, then the real one.
        expect(updatesIn(fly)).toHaveLength(2);
        expect(finalConfigOf(fly).env[STATE_PROBE_ENV]).toBeUndefined();
        expect(runningIn(fly)).toBe(true);
    });

    // An overlay is the owner's environment, built on a base only a rebuild moves; the heal gives it the tunnel as it is.
    it(`keeps an overlay machine on its overlay`, async () => {
        const overlay = `registry.fly.io/intentic-sbx-a@sha256:${`c`.repeat(64)}`;
        const fly = configuredFly(PRE_TUNNEL_ENV);
        machineIn(fly).config = { image: overlay, env: PRE_TUNNEL_ENV };
        await expect(wakeHosted(config(), { ...WAKE_TARGET, image: overlay, environmentHash: `h1` }, wakeArgs)).resolves.toBe(true);
        expect(finalConfigOf(fly).image).toBe(overlay);
        // Its own digest again converts nothing, so nothing was asked.
        expect(fly.called(`POST`, `/machines/m1/exec`)).toEqual([]);
        expect(updatesIn(fly)).toHaveLength(1);
    });

    // Mid-transition, a replacement would only earn a 412: the plain start answers, and the next wake asks again.
    it(`leaves a machine mid-transition to the plain start`, async () => {
        const fly = configuredFly(PRE_TUNNEL_ENV, `replacing`);
        await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).resolves.toBe(false);
        expect(updatesIn(fly)).toHaveLength(0);
    });

    /* THE WAKE IS NEVER WHAT STRANDS A MACHINE. Today's digest cannot convert this sandbox's state: the tunnel is healed
     * on the digest the machine already runs, and the wake answers as a woken machine. */
    it(`heals the tunnel on the version the machine runs when today's digest cannot convert its state`, async () => {
        const fly = configuredFly(PRE_TUNNEL_ENV);
        fly.commands.answer = () => ({ exit_code: 0, stdout: JSON.stringify({ ...CLEAR_STATE_PLAN, ok: false, failures: [{ document: `a.json`, detail: `no` }] }), stderr: `` });
        await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).resolves.toBe(true);
        expect(finalConfigOf(fly).image).toBe(PINNED);
        expect(finalConfigOf(fly).env[`INGRESS_URL`]).toBe(testIngressConfig.url);
        expect(finalConfigOf(fly).env[STATE_PROBE_ENV]).toBeUndefined();
        expect(runningIn(fly)).toBe(true);
    });

    // A gate that died mid-probe left a config that only sleeps: the wake re-applies the real one rather than starting it.
    it(`re-applies the config of a machine a dead gate left on its probe`, async () => {
        const fly = configuredFly({ ...currentTunnelEnv(), [STATE_PROBE_ENV]: PINNED });
        await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).resolves.toBe(true);
        expect(finalConfigOf(fly).image).toBe(`ghcr.io/intentic/sandbox@${STABLE_DIGEST}`);
        expect(finalConfigOf(fly).env[STATE_PROBE_ENV]).toBeUndefined();
        expect(runningIn(fly)).toBe(true);
    });

    /* A WAKE DURING A RESTART'S PROBE. The browser wakes whatever it cannot reach, and a machine mid-probe is exactly
     * that: its heal would start a second gate, replace the first one's probe under its exec, and the first gate would
     * read "no plan" and go ahead over its own refusal. The wake answers busy instead, and the refusal stands. */
    it(`answers busy while a restart is mid-probe, and the restart's refusal stands`, async () => {
        const fly = configuredFly(currentTunnelEnv(), `started`);
        let wake: Promise<unknown> | undefined;
        fly.commands.answer = () => {
            wake ??= wakeHosted(config(), WAKE_TARGET, wakeArgs).catch((error: unknown) => error);
            return { exit_code: 0, stdout: JSON.stringify({ ...CLEAR_STATE_PLAN, ok: false, failures: [{ document: `a.json`, detail: `no` }] }), stderr: `` };
        };
        await expect(refreshHosted(config(), wakeArgs(), { ...WAKE_TARGET, volumeId: `vol_1` }, logger)).rejects.toBeInstanceOf(HostedImageKept);
        expect(await wake).toBeInstanceOf(HostedMachineBusy);
        expect(fly.called(`POST`, `/machines/m1/exec`)).toHaveLength(1);
        expect(finalConfigOf(fly).image).toBe(PINNED);
        expect(finalConfigOf(fly).env[STATE_PROBE_ENV]).toBeUndefined();
        expect(runningIn(fly)).toBe(true);
    });

    // A probe caught starting or stopping is a gate at work: never started as if it were the sandbox.
    it(`answers busy for a probe caught mid-transition, and starts nothing`, async () => {
        const fly = configuredFly({ [STATE_PROBE_ENV]: PINNED }, `replacing`);
        await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).rejects.toBeInstanceOf(HostedMachineBusy);
        expect(fly.called(`POST`, `/machines/m1/start`)).toEqual([]);
        expect(updatesIn(fly)).toHaveLength(0);
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
        hostedMachine: { findMany: jest.fn().mockResolvedValue([{ appName: `intentic-sbx-live` }]) },
        hostedPoolMachine: { findMany: jest.fn().mockResolvedValue([{ appName: `intentic-sbx-pool-warm1` }]) },
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

    it(`spares the app of a deleted sandbox still inside its recovery window`, async () => {
        const calls = stubFetch([
            appList(`intentic-sbx-deleted`),
            // Stamped ours and holding no machine row: without the trash read this is the reaper's clearest orphan,
            // and destroying it would take the volume the owner can still restore from.
            machinesOf({ "intentic-sbx-deleted": [flyMachine({ platform: INSTANCE })] }),
            deleteRoute,
        ]);
        const held = fakePrisma({ sandboxTrash: { findMany: jest.fn().mockResolvedValue([{ appName: `intentic-sbx-deleted` }]) } });
        await reapHostedOrphans(held as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
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
        await reapHostedOrphans(fakePrisma({ hostedMachine: { findMany: jest.fn().mockResolvedValue([]) } }) as never, config(), logger);
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
        jest.fn().mockImplementation((query?: { where?: unknown }) => Promise.resolve(query?.where === undefined ? machines : 0));

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
            context: routeContext({ prisma: fakePrisma({ hostedMachine: { count: jest.fn().mockResolvedValue(0) } }) }),
        });
        // Ceiling is surfaced before any of it is spent, so the offer card doesn't say "free" and correct itself later.
        expect(on).toEqual({ enabled: true, remaining: 1, hours: { allowance: 40, remaining: 40 } });
    });

    /* THE CARD OFFERS A FREE MACHINE, so it states the free plan's hours even to somebody on the plan: a plan buys
     * slots at a bigger rung, and the machine this card would hand over is still a free one. (`plan` is absent here
     * because this platform sells nothing; the case below sets a price and gets it.) */
    it(`tells a subscriber the free plan's hours too, since the machine on offer is still a free one`, async () => {
        const member = fakePrisma({
            hostedMachine: { count: jest.fn().mockResolvedValue(0) },
            // Plan row: status and the slots it holds at each rung.
            hostedPlan: { findUnique: jest.fn().mockResolvedValue({ status: `active`, items: [] }) },
        });
        expect(await call(sandboxRoutes.hostedOffer, undefined, { context: routeContext({ prisma: member }) })).toEqual({
            enabled: true,
            remaining: 1,
            hours: { allowance: config().hosted.monthlyHours, remaining: config().hosted.monthlyHours },
        });
        const uncapped = routeContext({
            prisma: fakePrisma({ hostedMachine: { count: jest.fn().mockResolvedValue(0) } }),
            config: config({ hosted: { ...config().hosted, monthlyHours: 0 } }),
        });
        expect(await call(sandboxRoutes.hostedOffer, undefined, { context: uncapped })).toEqual({ enabled: true, remaining: 1 });
        // Where the plan is actually for sale, the same owner is told they're on it (`plan: true`), distinguishing this
        // from the uncapped case above.
        const selling = routeContext({
            prisma: member,
            config: config({ hostedPlan: { ...config().hostedPlan, stripeSecretKey: `sk`, stripePrices: `${ENTRY.id}=price_${ENTRY.id}` } }),
        });
        expect(await call(sandboxRoutes.hostedOffer, undefined, { context: selling })).toEqual({
            enabled: true,
            remaining: 1,
            // The hours are the free plan's, which is what the machine on offer would be; the plan buys a rung beside it.
            hours: { allowance: config().hosted.monthlyHours, remaining: config().hosted.monthlyHours },
            plan: true,
        });
    });

    // PAYMENT_REQUIRED specifically, so the editor can offer membership without parsing the message.
    it(`wake refuses a non-member whose month is spent, and never touches the provider`, async () => {
        const fetchSpy = stubFetch([]);
        const spent = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue({
                    id: `s1`,
                    ownerId: `u1`,
                    hosted: { id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null, tier: `free` },
                }),
            },
            hostedUsage: { findUnique: jest.fn().mockResolvedValue({ minutes: 40 * 60 }) },
        });
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: spent }) })).rejects.toMatchObject({
            code: `PAYMENT_REQUIRED`,
        });
        expect(fetchSpy).toHaveLength(0);
    });

    /* THE CEILING IS THE MACHINE'S RUNG'S. The same spent month that refuses a free machine's wake is nowhere near
     * a Standard one's, and the rung on the row is the only thing that decides which. */
    it(`wakes a machine on a paid rung past the hours a free one would have spent`, async () => {
        stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ ok: true }) }]);
        const spent = (tier: string) =>
            fakePrisma({
                sandbox: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: `s1`,
                        ownerId: `u1`,
                        hosted: { id: `h1`, sandboxId: `s1`, tier, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null },
                    }),
                },
                hostedUsage: { findUnique: jest.fn().mockResolvedValue({ minutes: FREE_TIER.monthlyHours * 60 }) },
                hostedPlan: { findUnique: jest.fn().mockResolvedValue({ status: `active`, items: [] }) },
                // The row the wake opens its stretch on, still there when the start lands.
                hostedMachine: { findUnique: jest.fn().mockResolvedValue({ wokeAt: null }) },
            });
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: spent(FREE_TIER.id) }) })).rejects.toThrow(
            /free hours are used up/u,
        );
        expect(await call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: spent(PAID.id) }) })).toEqual({ ok: true });
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
        bootReport: null,
        announceRefusal: null,
        removedAt: null,
        removedBy: null,
    };

    it(`hostedProvision refuses over-quota before touching any provider`, async () => {
        const fetchSpy = stubFetch([]);
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(1) },
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
            hostedPoolMachine: { count: jest.fn().mockResolvedValue(0) },
            hostedBuild: { count: jest.fn().mockResolvedValue(0) },
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
            hostedPoolMachine: { count: jest.fn().mockResolvedValue(2) },
            hostedBuild: { count: jest.fn().mockResolvedValue(0) },
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
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue(null), count: fleetOf(100) },
            hostedPoolMachine: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
            hostedBuild: { count: jest.fn().mockResolvedValue(0) },
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
                findFirst: jest.fn().mockResolvedValue(ownedRow),
                findUniqueOrThrow: jest.fn().mockResolvedValue({ ...ownedRow, hosted: { region: `iad`, warm: true } }),
            },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue({ appName: `intentic-sbx-pool-abc123`, machineId: `m1` }), count: jest.fn() },
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
                findFirst: jest.fn().mockResolvedValue(ownedRow),
                findUniqueOrThrow: jest.fn().mockResolvedValue({ ...ownedRow, hosted: { region: `iad`, warm: true } }),
                update: jest.fn().mockResolvedValue(ownedRow),
            },
            hostedMachine: {
                // Null for the route's own pre-flight read, then the winner's row once the write is refused.
                findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ id: `hm1` }),
                count: jest.fn().mockResolvedValue(0),
                create: jest.fn().mockRejectedValue(duplicate),
            },
        });
        const context = routeContext({ prisma, headers: new Headers() });
        const summary = await call(sandboxRoutes.hostedProvision, { sandboxId: `s1`, token: `t0k3n` }, { context });
        expect(summary.hosted).toEqual({ region: `iad`, warm: true });
        expect(calls.some((entry) => entry.method === `DELETE` && entry.url.includes(`/apps/intentic-sbx-`))).toBe(true);
    });

    it.each([null, new Date()])(`hostedRelease durably cancels setup with lastSeenAt %s`, async (lastSeenAt) => {
        const fetch = jest.fn();
        stubGlobal(`fetch`, fetch);
        const machineDelete = jest.fn().mockResolvedValue({});
        const upsert = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue({ ...ownedRow, lastSeenAt }),
                findUniqueOrThrow: jest.fn()
                    .mockResolvedValueOnce({ ...ownedRow, lastSeenAt, hosted: { id: `h1`, appName: `intentic-sbx-a`, wokeAt: null } })
                    .mockResolvedValue({ ...ownedRow, hosted: null }),
            },
            hostedCleanup: { upsert },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue({ appName: `intentic-sbx-a` }), delete: machineDelete },
        });
        const before = Date.now();
        const summary = await call(sandboxRoutes.hostedRelease, { sandboxId: `s1` }, { context: routeContext({ prisma }) });
        const after = Date.now();
        expect(summary.hosted).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
        expect(machineDelete).toHaveBeenCalledTimes(1);
        expect(machineDelete).toHaveBeenCalledWith({ where: { id: `h1` } });
        expect(upsert).toHaveBeenCalledTimes(1);
        // Releasing a machine destroys the volume under it, so the teardown is DATED rather than queued for now:
        // the disk outlives the machine by the recovery window.
        const [[queued]] = upsert.mock.calls as [[{ where: unknown; create: { deleteAfter: Date }; update: { deleteAfter: Date } }]];
        expect(queued.where).toEqual({ appName: `intentic-sbx-a` });
        expect(queued.update.deleteAfter).toEqual(queued.create.deleteAfter);
        expect(queued.create.deleteAfter.getTime()).toBeGreaterThanOrEqual(before + RECOVERY_WINDOW_MS);
        expect(queued.create.deleteAfter.getTime()).toBeLessThanOrEqual(after + RECOVERY_WINDOW_MS);
    });

    it(`hostedRestart refreshes the current image onto the existing volume before starting`, async () => {
        const fly = configuredFly(currentTunnelEnv(), `started`, (url) =>
            url.endsWith(`/api/v2/namespaces`) ? json([{ namespaceToken: `ns-1`, name: `public`, open: true }]) : undefined,
        );
        const hosted = { ...RESTART_ROW };
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue(hosted), update: jest.fn().mockResolvedValue({}) },
        });

        expect(await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ ok: true });
        // Today's stock digest, on the same volume, with this sandbox's identity; the planner was asked first.
        const applied = finalConfigOf(fly);
        expect(applied.image).toBe(`ghcr.io/intentic/sandbox@${STABLE_DIGEST}`);
        expect(applied.mounts).toEqual([{ volume: `vol_1`, path: `/data` }]);
        expect(applied.env[`CONNECT_TOKEN`]).toBe(`t0k3n`);
        expect(applied.env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        expect(fly.called(`POST`, `/machines/m1/exec`)).toHaveLength(1);
        // Restart replaces the config too, so it must observe the machine running rather than merely asking it to.
        const lastUpdate = fly.calls.findLastIndex((entry) => entry.method === `POST` && entry.path.endsWith(`/machines/m1`));
        expect(fly.calls.findLastIndex((entry) => entry.path.endsWith(`/machines/m1/start`))).toBeGreaterThan(lastUpdate);
        expect(runningIn(fly)).toBe(true);
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: `h1` }, data: expect.objectContaining({ wokeAt: expect.any(Date) }) }));
    });

    /* THE STATE GATE'S REFUSAL, where the owner reads it. Today's digest cannot convert this sandbox's stored state, so
     * the restart keeps the version the machine ran (with the fresh config around it), runs it, meters it, and answers
     * the conflict in the refusal's own words. */
    it(`hostedRestart keeps the machine's version and says why when today's digest cannot convert its state`, async () => {
        const fly = configuredFly(currentTunnelEnv(), `started`);
        fly.commands.answer = () => ({
            exit_code: 0,
            stdout: `${JSON.stringify({ ...CLEAR_STATE_PLAN, ok: false, failures: [{ document: `notes/theme.json`, detail: `theme: not a colour` }] })}\n`,
            stderr: ``,
        });
        const stretch = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue({ ...RESTART_ROW }), update: stretch },
        });
        const refused = await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) }).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ORPCError);
        expect(refused).toMatchObject({
            code: `CONFLICT`,
            message: `intentic 9.9.9 cannot convert this sandbox's stored state, so the update was stopped before it began and the sandbox stays on the version it had (notes/theme.json: theme: not a colour)`,
        });
        expect(finalConfigOf(fly).image).toBe(PINNED);
        expect(finalConfigOf(fly).env[STATE_PROBE_ENV]).toBeUndefined();
        expect(runningIn(fly)).toBe(true);
        expect(stretch).toHaveBeenCalledWith(expect.objectContaining({ where: { id: `h1` }, data: expect.objectContaining({ wokeAt: expect.any(Date) }) }));
    });

    // Same sandbox identity (name, address, sharing) on a fresh, empty disk; nothing on a destroyed machine is worth
    // preserving.
    it(`hostedRestart builds a replacement when the provider says the machine is gone`, async () => {
        const machineCreate = jest.fn().mockResolvedValue({});
        // The dead row until the rebuild deletes it; after that the sandbox has no row, as the new app's check expects.
        let row: Record<string, unknown> | null = {
            id: `h1`,
            appName: `intentic-sbx-a`,
            machineId: `m1`,
            volumeId: `vol_1`,
            region: `iad`,
            wokeAt: null,
            tier: `free`,
        };
        const rowDelete = jest.fn(async () => {
            row = null;
            return {};
        });
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
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow) },
            hostedMachine: {
                findUnique: jest.fn(async () => row),
                create: machineCreate,
                delete: rowDelete,
                update: jest.fn().mockResolvedValue({}),
            },
        });
        expect(await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ ok: true });
        // Dead row is deleted first: `sandboxId` is unique, so the replacement can't be written beside it.
        expect(rowDelete).toHaveBeenCalledWith({ where: { id: `h1` } });
        expect(machineCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ machineId: `m2`, sandboxId: `s1` }) }));
        expect(calls.some((entry) => entry.url.endsWith(`/apps`))).toBe(true);
    });

    it(`hostedRestart destroys nothing when the provider merely refuses`, async () => {
        const rowDelete = jest.fn();
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
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow) },
            hostedMachine: {
                findUnique: jest.fn().mockResolvedValue({
                    id: `h1`,
                    appName: `intentic-sbx-a`,
                    machineId: `m1`,
                    volumeId: `vol_1`,
                    region: `iad`,
                    wokeAt: null,
                    tier: `free`,
                }),
                delete: rowDelete,
                update: jest.fn().mockResolvedValue({}),
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
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue({ appName: `intentic-sbx-a`, machineId: `m1` }) },
        });
        expect(await call(sandboxRoutes.hostedStatus, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ machine: `gone` });
    });

    it(`wake 404s for a sandbox that is not hosted (or not the caller's)`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).rejects.toBeInstanceOf(ORPCError);
    });

    it(`wake drops the row and the sandbox's dead address when the provider has no such machine`, async () => {
        stubFetch([{ match: () => true, respond: () => json({ error: `machine not found` }, 404) }]);
        const written: unknown[] = [];
        const prisma = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue({
                    id: `s1`,
                    ownerId: `u1`,
                    hosted: { id: `h1`, sandboxId: `s1`, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null, tier: `free` },
                }),
                update: jest.fn((args: unknown) => {
                    written.push(args);
                    return Promise.resolve({});
                }),
            },
            hostedMachine: {
                findUnique: jest.fn().mockResolvedValue({ wokeAt: null }),
                delete: jest.fn((args: unknown) => {
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
        const remove = jest.fn();
        const prisma = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue({
                    id: `s1`,
                    ownerId: `u1`,
                    hosted: { id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null, tier: `free` },
                }),
                update: jest.fn().mockResolvedValue({}),
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
        const findFirst = jest.fn().mockResolvedValue({
            id: `s1`,
            hosted: { id: `h1`, sandboxId: `s1`, appName: `intentic-sbx-a`, machineId: `m1`, region: `iad`, tier: `free` },
        });
        const prisma = fakePrisma({ sandbox: { findFirst }, hostedMachine: { findUnique: jest.fn().mockResolvedValue({ wokeAt: null }) } });
        const result = await call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma }) });
        expect(result).toEqual({ ok: true });
        // Access query admits owner OR accepted member; the OR is the contract under test.
        expect(findFirst.mock.calls[0]?.[0]?.where?.OR).toHaveLength(2);
    });

    /* THE GO-LIVE'S STRANDING CASE. A machine configured before hosted machines dialled the edge (71dbfb7145) has no
     * SANDBOX_GRANT and no INGRESS_URL, and once the edge terminates TLS itself there is no replay to reach it by. Its
     * next wake must hand it the tunnel, meter the wake like any other, and leave it able to say it is reachable: the
     * grant the edge will check names the id the edge reads off the machine's own address, and the daemon's report,
     * authenticated by the token in that same environment, lands. Woken by a member, so the owner's address is kept. */
    it(`a machine configured before 71dbfb7145 wakes, gets the grant, and reports reachable`, async () => {
        const fly = configuredFly(PRE_TUNNEL_ENV);
        const row = {
            id: `s1`,
            ownerId: `u1`,
            token: WAKE_TOKEN,
            owner: { email: `Owner@Example.com` },
            hosted: { id: `h1`, sandboxId: `s1`, region: `iad`, tier: FREE_TIER.id, wokeAt: null, ...WAKE_TARGET },
        };
        const stretch = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(row) },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue({ wokeAt: null }), update: stretch },
        });
        const member = { id: `u2`, email: `member@example.com`, name: `Member`, image: null };
        expect(await call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma, user: member }) })).toEqual({ ok: true });

        const { env } = finalConfigOf(fly);
        expect(env[`INGRESS_URL`]).toBe(testIngressConfig.url);
        expect(env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        const grant = verifyReachabilityGrant(publicKeyPemOf(testIngressConfig.signingKey), env[`SANDBOX_GRANT`] ?? ``);
        expect(grant?.sandboxId).toBe(hostOwnerId(new URL(env[`SANDBOX_PUBLIC_URL`] ?? ``).host));
        expect(runningIn(fly)).toBe(true);
        // Metered as a wake: the stretch opens on the row once the machine runs.
        expect(stretch).toHaveBeenCalledWith(expect.objectContaining({ where: { id: `h1` }, data: expect.objectContaining({ wokeAt: expect.any(Date) }) }));

        // The api the daemon reports to, as a whole app: the route authenticates by the connect token alone.
        const appConfig = configSchema.parse({
            database: { url: `postgres://x`, poolMax: 10 },
            betterAuth: { secret: `s` },
            secrets: { key: `` },
            webOrigin: `https://app.test`,
            google: { clientId: ``, clientSecret: `` },
            email: { apiKey: ``, from: `` },
            ingress: testIngressConfig,
            api: { url: `https://api.test`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
            log: { level: `silent`, pretty: `false` },
        });
        // SAFETY: the app reads only these four methods and `child` from its logger on this route.
        const appLogger = { child: () => appLogger, info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never;
        const reported = jest.fn().mockResolvedValue({ count: 1 });
        const daemonSide = fakePrisma({
            sandbox: { findUnique: jest.fn().mockResolvedValue({ id: `s1`, tokenDigest: sha256Hex(WAKE_TOKEN) }), updateMany: reported },
        });
        const answer = await createApp(appConfig, daemonSide, appLogger).app.request(`/sandbox/boot-report`, {
            method: `POST`,
            headers: { "content-type": `application/json`, "x-intentic-connect": env[`CONNECT_TOKEN`] ?? `` },
            body: JSON.stringify({ reach: `reachable` }),
        });
        expect(answer.status).toBe(200);
        expect(reported).toHaveBeenCalledWith({
            where: { id: `s1`, tokenDigest: sha256Hex(WAKE_TOKEN) },
            data: { bootReport: { reach: `reachable`, at: expect.any(String) } },
        });
    });

    // A trash, a release or the idle sweep deleted the row between this wake's read and its start (specs/HostedStretch.tla).
    it(`wake stops the machine it started when the row went meanwhile`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1/start`), respond: () => json({ ok: true }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1/stop`), respond: () => json({ ok: true }) },
        ]);
        const prisma = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue({
                    id: `s1`,
                    ownerId: `u1`,
                    hosted: { id: `h1`, sandboxId: `s1`, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null, tier: `free` },
                }),
            },
            // What the stretch's row lock finds: no row.
            hostedMachine: { findUnique: jest.fn().mockResolvedValue(null) },
        });
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).rejects.toMatchObject({
            code: `NOT_FOUND`,
        });
        expect(calls.filter((entry) => entry.method === `POST`).map((entry) => entry.url.split(`/`).pop())).toEqual([`start`, `stop`]);
    });
});
