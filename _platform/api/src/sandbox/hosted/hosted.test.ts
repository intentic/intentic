import { apiContract } from "@intentic/api-contract";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { FREE_TIER, type HostedTier, PAID_TIERS, WORKSPACE_ROOT } from "@intentic/constants";
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
    hostedMachineConfig,
    hostedEnabled,
    hostedInstanceId,
    HostedAppNotOurs,
    HostedNothingKept,
    provisionHosted,
    reapHostedOrphans,
    refreshHosted,
    rollbackHosted,
    startAfterUpdate,
    wakeHosted,
    type HostedProvisionArgs,
} from "./hosted.js";
import { HostedAlreadyProvisioned } from "./hosted-cleanup.js";
import { ENV_PROJECT_DIR } from "./hosted-project.js";
import { definitionSeedFor, ENV_DEFINITION_SEED } from "../profiles/profiles.js";
import { hostedShapeFor } from "./hosted-shape.js";
import { AT_CAPACITY_MESSAGE, forgetProviderCapacity, HostedAtCapacity } from "./hosted-capacity.js";
import { forgetHostedImage } from "./build/hosted-image.js";
import { HostedImageKept, HostedMachineBusy, probeConfig, STATE_PROBE_ENV } from "./gate/state-gate.js";
import { CLEAR_STATE_PLAN, type FakeFly, type FakeFlyCall, type FakeFlyMachine, installFakeFly } from "@intentic/testing/fly-fake";
import { checkingIn, fakeGateRecord, fakeHostedAppLock, healthAnswer, machineAnswers, testIngressConfig } from "../../testing.js";
import { DAEMON_HEALTH_COMMAND } from "./gate/daemon-health.js";
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
        // Nothing spent this month unless a test says so: the meter's one read groups the month by machine and hours.
        hostedUsage: {
            upsert: jest.fn().mockResolvedValue({}),
            groupBy: jest.fn().mockResolvedValue([]),
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
        // The deletion records the reaper destroys on: none unless a test says which sandboxes were deleted.
        sandboxTombstone: {
            findMany: jest.fn().mockResolvedValue([]),
            ...overrides[`sandboxTombstone`],
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
            // The reaper's "does this app's sandbox still exist" read: none unless a test says so.
            findMany: jest.fn().mockResolvedValue([]),
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

// The cases `ic` and the desktop app are held to (_sandbox/ic/src/sandbox/project_dir.rs, setup_link.rs), read from the
// one file every side runs.
interface ProjectDirCases {
    readonly names: readonly { readonly name: string; readonly valid: boolean }[];
}
// SAFETY: the fixture is this repository's own file, written to this shape; one that drifted fails every case below.
const PROJECT_DIR_CASES = JSON.parse(
    readFileSync(join(repoRoot(import.meta.url), `_shared/sandbox-contract/src/ids/project-dir.fixture.json`), `utf8`),
) as ProjectDirCases;

/* A HOSTED PROJECT'S FOLDER NAME is held at the door to the rule `ic` and the desktop app hold it to: a name that could
 * land on the daemon's own state, outside /work or on a starter it seeds would reach the machine's environment, where
 * the daemon would refuse to boot on it. */
describe(`the folder a hosted project is provisioned for`, () => {
    const input = apiContract.sandbox.hostedProvision[`~orpc`].inputSchema;
    if (input === undefined) {
        throw new Error(`hostedProvision declares no input schema`);
    }

    it.each([...PROJECT_DIR_CASES.names])(`takes $name exactly when ic and the desktop app would ($valid)`, ({ name, valid }) => {
        expect(input.safeParse({ sandboxId: `s1`, token: `t0k3n`, project: name }).success).toBe(valid);
    });

    // An editor from before hosted projects names none, and gets the ordinary sandbox it always got.
    it(`is optional`, () => {
        expect(input.parse({ sandboxId: `s1`, token: `t0k3n` })).toEqual({ sandboxId: `s1`, token: `t0k3n` });
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
    /* A PROJECT'S MACHINE is told its folder exactly as `ic` tells a project container (connect.rs): the whole of
     * `/work/<name>`, and the profile's seed beside it as any machine gets it. A probe keeps the folder and nothing
     * else of the config, since the folder is no credential and a dead probe's replacement reads it back. */
    it(`names a project's folder in its environment, and nobody else's`, () => {
        const before = `ghcr.io/intentic/sandbox@sha256:${`a`.repeat(64)}`;
        const project = hostedMachineConfig(config(), { ...args, project: `My_App.v2`, profile: `desk` }, `intentic-sbx-a`, `vol_1`);
        expect([project.env[ENV_PROJECT_DIR], project.env[ENV_DEFINITION_SEED]]).toEqual([`${WORKSPACE_ROOT}/My_App.v2`, definitionSeedFor(`desk`)]);
        expect(probeConfig(project, before).env).toEqual({ [STATE_PROBE_ENV]: before, [ENV_PROJECT_DIR]: `${WORKSPACE_ROOT}/My_App.v2` });
        const ordinary = hostedMachineConfig(config(), args, `intentic-sbx-a`, `vol_1`);
        expect(Object.keys(ordinary.env)).not.toContain(ENV_PROJECT_DIR);
        expect(probeConfig(ordinary, before).env).toEqual({ [STATE_PROBE_ENV]: before });
    });

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
        // No front door: the edge terminates TLS itself, so the tunnel is the only way in and no Fly proxy routes here.
        expect(machine.config).not.toHaveProperty(`services`);
        expect(machine.config).not.toHaveProperty(`checks`);
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

    it(`refuses without making anything on the provider when the fleet is at its ceiling`, async () => {
        const fetchSpy = stubFetch([]);
        const full = fakePrisma({
            hostedMachine: { create: jest.fn(), count: jest.fn().mockResolvedValue(100) },
            hostedPoolMachine: { count: jest.fn().mockResolvedValue(0) },
            hostedBuild: { count: jest.fn().mockResolvedValue(0) },
        });
        await expect(
            provisionHosted(full as never, config({ hosted: { ...config().hosted, maxMachines: 100 } }), logger, args),
        ).rejects.toBeInstanceOf(HostedAtCapacity);
        // Only the read of whether this sandbox's own app is still on the provider (heldAppOf).
        expect(fetchSpy.map((entry) => entry.method)).toEqual([`GET`]);
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

    // The provider has no app named for this sandbox yet: the ordinary case, and the only one the warm pool is asked in
    // (hosted.ts heldAppOf). A case that does not answer this read gets a cold build, never a claim.
    const OWN_APP = `intentic-sbx-${sandboxIdFromToken(`t0k3n`)}`;
    const noOwnApp = {
        match: (method: string, url: string) => method === `GET` && url.endsWith(`/apps/${OWN_APP}`),
        respond: () => json({ error: `Could not find App "${OWN_APP}"` }, 404),
    };

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
            noOwnApp,
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
        // App was named for its build-time token, and its daemon's tunnel grant names the id that token carries: this
        // machine's identity must become the sandbox it now serves.
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
            noOwnApp,
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
            noOwnApp,
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
            noOwnApp,
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
            noOwnApp,
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
            noOwnApp,
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
                findMany: jest
                    .fn()
                    .mockResolvedValue([
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
            noOwnApp,
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
            noOwnApp,
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

    /* FLY LOST THE MACHINE, NOT THE DISK. The platform dropped the row (`forgetHostedMachine`), and the next provision
     * computes the same app name from the same token: the app and its volume are this sandbox's, and it takes them
     * back rather than failing at createApp, or claiming warm stock and rotating its token away from its own disk. */
    describe(`this sandbox's own app, still on the provider`, () => {
        const ownApp = {
            match: (method: string, url: string) => method === `GET` && url.endsWith(`/apps/${OWN_APP}`),
            respond: () => json({ name: OWN_APP }),
        };
        const ownMachines = (machines: unknown[]) => ({
            match: (method: string, url: string) => method === `GET` && url.endsWith(`/apps/${OWN_APP}/machines`),
            respond: () => json(machines),
        });
        const ownVolumes = {
            match: (method: string, url: string) => method === `GET` && url.endsWith(`/apps/${OWN_APP}/volumes`),
            respond: () =>
                json([
                    { id: `vol_old`, created_at: `2026-09-01T00:00:00Z`, region: `arn`, size_gb: 20 },
                    { id: `vol_new`, created_at: `2026-09-20T00:00:00Z`, region: `arn`, size_gb: 20 },
                ]),
        };
        const anyCreate = (calls: { method: string; url: string }[]) =>
            calls.filter((entry) => entry.method === `POST` && (entry.url.endsWith(`/apps`) || entry.url.endsWith(`/volumes`)));

        it(`makes a new machine on the newest volume, in the volume's region and at its size, and asks the pool nothing`, async () => {
            const created = jest.fn().mockResolvedValue({});
            const claim = jest.fn().mockResolvedValue({ count: 1 });
            const calls = stubFetch([
                ownApp,
                ownMachines([]),
                ownVolumes,
                {
                    match: (method, url) => method === `POST` && url.endsWith(`/apps/${OWN_APP}/machines`),
                    respond: () => json({ id: `m9`, state: `created` }),
                },
            ]);
            const cleanup = jest.fn().mockResolvedValue({});
            const prisma = fakePrisma({
                hostedMachine: { create: created },
                hostedPoolMachine: { findMany: jest.fn().mockResolvedValue([poolRow]), updateMany: claim },
                hostedCleanup: { create: cleanup },
            });
            expect(await provisionHosted(prisma as never, config(), logger, args)).toEqual({ appName: OWN_APP, region: `arn`, warm: false });
            expect(anyCreate(calls)).toEqual([]);
            const made = calls.find((entry) => entry.method === `POST` && entry.url.endsWith(`/machines`))?.body as {
                region: string;
                config: { mounts: { volume: string; path: string }[] };
            };
            expect(made.region).toBe(`arn`);
            expect(made.config.mounts).toEqual([{ volume: `vol_new`, path: FLY_VOLUME_PATH }]);
            expect(created).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    sandboxId: `s1`,
                    appName: OWN_APP,
                    machineId: `m9`,
                    volumeId: `vol_new`,
                    region: `arn`,
                    volumeGb: 20,
                }),
            });
            // Warm stock would rotate the token away from this disk; the cleanup record would delete it on a failure.
            expect(claim).not.toHaveBeenCalled();
            expect(cleanup).not.toHaveBeenCalled();
            expect(calls.some((entry) => entry.method === `DELETE`)).toBe(false);
        });

        it(`re-configures a machine of its own it finds there, onto the volume that machine mounts, and starts it`, async () => {
            const created = jest.fn().mockResolvedValue({});
            const mine = {
                id: `m5`,
                state: `stopped`,
                created_at: `2026-09-20T00:00:00Z`,
                config: { metadata: { intentic_role: `sandbox`, intentic_platform: INSTANCE } },
            };
            const calls = stubFetch([
                ownApp,
                ownMachines([mine]),
                ownVolumes,
                {
                    match: (method, url) => method === `GET` && url.endsWith(`/machines/m5`),
                    respond: () =>
                        json({
                            id: `m5`,
                            state: `started`,
                            config: { image: `ghcr.io/intentic/sandbox:old`, mounts: [{ volume: `vol_old`, path: `/data` }] },
                        }),
                },
                { match: (method, url) => method === `POST` && url.endsWith(`/machines/m5`), respond: () => json({ id: `m5`, state: `stopped` }) },
            ]);
            await provisionHosted(fakePrisma({ hostedMachine: { create: created } }) as never, config(), logger, args);
            const update = calls.find((entry) => entry.method === `POST` && entry.url.endsWith(`/machines/m5`))?.body as {
                config: { mounts: { volume: string; path: string }[]; env: Record<string, string> };
            };
            expect(update.config.mounts).toEqual([{ volume: `vol_old`, path: FLY_VOLUME_PATH }]);
            expect(update.config.env[`CONNECT_TOKEN`]).toBe(`t0k3n`);
            expect(calls.some((entry) => entry.method === `POST` && entry.url.endsWith(`/apps/${OWN_APP}/machines`))).toBe(false);
            expect(created).toHaveBeenCalledWith({ data: expect.objectContaining({ machineId: `m5`, volumeId: `vol_old` }) });
        });

        it(`never adopts an app holding a machine another deployment stamped, and touches nothing in it`, async () => {
            const calls = stubFetch([ownApp, ownMachines([flyMachine({ platform: `deadbeefcafe`, role: `sandbox` })]), ownVolumes]);
            await expect(
                provisionHosted(fakePrisma({ hostedMachine: { create: jest.fn() } }) as never, config(), logger, args),
            ).rejects.toBeInstanceOf(HostedAppNotOurs);
            expect(calls.filter((entry) => entry.method !== `GET`)).toEqual([]);
        });

        it(`builds to order without the warm pool when the provider cannot say whether the app is there`, async () => {
            const claim = jest.fn().mockResolvedValue({ count: 1 });
            const calls = stubFetch([
                {
                    match: (method, url) => method === `GET` && url.endsWith(`/apps/${OWN_APP}`),
                    respond: () => json({ error: `internal error` }, 500),
                },
                { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `a1` }) },
                { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
                { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
            ]);
            const prisma = fakePrisma({
                hostedMachine: { create: jest.fn().mockResolvedValue({}) },
                hostedPoolMachine: { findMany: jest.fn().mockResolvedValue([poolRow]), updateMany: claim },
            });
            expect((await provisionHosted(prisma as never, config(), logger, args)).warm).toBe(false);
            expect(claim).not.toHaveBeenCalled();
            expect(calls.some((entry) => entry.method === `POST` && entry.url.endsWith(`/apps`))).toBe(true);
        });

        it(`takes back down only the machine it made when the adoption fails, never the app or its disk`, async () => {
            const calls = stubFetch([
                ownApp,
                ownMachines([]),
                ownVolumes,
                {
                    match: (method, url) => method === `POST` && url.endsWith(`/apps/${OWN_APP}/machines`),
                    respond: () => json({ id: `m9`, state: `created` }),
                },
                { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 200 }) },
            ]);
            const failing = fakePrisma({ hostedMachine: { create: jest.fn().mockRejectedValue(new Error(`database went away`)) } });
            await expect(provisionHosted(failing as never, config(), logger, args)).rejects.toThrow(/database went away/);
            expect(calls.filter((entry) => entry.method === `DELETE`).map((entry) => entry.url)).toEqual([
                `https://api.machines.dev/v1/apps/${OWN_APP}/machines/m9?force=true`,
            ]);
        });
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
// What was run inside the machine, in order: the state planner in a probe, and the new daemon's /health once it ran.
const execsIn = (fly: FakeFly): string[] =>
    fly.called(`POST`, `/machines/m1/exec`).map((exec) => (JSON.stringify(exec.body).includes(DAEMON_HEALTH_COMMAND[0]) ? `health` : `planner`));
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
const RESTART_ROW = {
    id: `h1`,
    sandboxId: `s1`,
    appName: `intentic-sbx-a`,
    machineId: `m1`,
    volumeId: `vol_1`,
    region: `iad`,
    wokeAt: null,
    tier: `free`,
};

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
        // A new digest is an image change: its planner was asked first, in a probe, and the machine runs the real config
        // once its daemon has said it came up.
        expect(execsIn(fly)).toEqual([`planner`, `health`]);
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
        [
            `a grant for another sandbox`,
            () => ({ ...currentTunnelEnv(), SANDBOX_GRANT: mintReachabilityGrant(testIngressConfig.signingKey, `0123456789ab`, Date.now()) }),
        ],
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
        fly.commands.answer = () => ({
            exit_code: 0,
            stdout: JSON.stringify({ ...CLEAR_STATE_PLAN, ok: false, failures: [{ document: `a.json`, detail: `no` }] }),
            stderr: ``,
        });
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
            return {
                exit_code: 0,
                stdout: JSON.stringify({ ...CLEAR_STATE_PLAN, ok: false, failures: [{ document: `a.json`, detail: `no` }] }),
                stderr: ``,
            };
        };
        await expect(refreshHosted(config(), wakeArgs(), { ...WAKE_TARGET, volumeId: `vol_1` }, logger)).rejects.toBeInstanceOf(HostedImageKept);
        expect(await wake).toBeInstanceOf(HostedMachineBusy);
        expect(fly.called(`POST`, `/machines/m1/exec`)).toHaveLength(1);
        expect(finalConfigOf(fly).image).toBe(PINNED);
        expect(finalConfigOf(fly).env[STATE_PROBE_ENV]).toBeUndefined();
        expect(runningIn(fly)).toBe(true);
    });

    /* A PROJECT'S MACHINE KEEPS ITS FOLDER through every config written over it, the state gate's probe included: nothing
     * but the machine's own environment records it (hosted-project.ts). */
    describe(`a project's machine`, () => {
        const FOLDER = `${WORKSPACE_ROOT}/my-app`;
        const foldersWritten = (fly: FakeFly): (string | undefined)[] =>
            // SAFETY: fly.ts sends every config replacement as `{ config }`, a FlyMachineConfig.
            updatesIn(fly).map((update) => (update.body as { config: { env: Record<string, string> } }).config.env[ENV_PROJECT_DIR]);

        it(`keeps its folder through a wake's heal and a restart, their probes included`, async () => {
            const fly = configuredFly({ ...PRE_TUNNEL_ENV, [ENV_PROJECT_DIR]: FOLDER });
            await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).resolves.toBe(true);
            await refreshHosted(config(), wakeArgs(), WAKE_TARGET);
            expect(execsIn(fly)).toContain(`planner`);
            expect(new Set(foldersWritten(fly))).toEqual(new Set([FOLDER]));
        });

        // A gate that died mid-probe left the folder beside its marker, which is where the config replacing it reads it.
        it(`gets its folder back from a dead gate's probe`, async () => {
            const fly = configuredFly({ ...currentTunnelEnv(), [STATE_PROBE_ENV]: PINNED, [ENV_PROJECT_DIR]: FOLDER });
            await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).resolves.toBe(true);
            expect([finalConfigOf(fly).env[STATE_PROBE_ENV], finalConfigOf(fly).env[ENV_PROJECT_DIR]]).toEqual([undefined, FOLDER]);
        });

        it(`goes back to an earlier version with its folder`, async () => {
            const fly = configuredFly({ ...currentTunnelEnv(), [ENV_PROJECT_DIR]: FOLDER });
            machineIn(fly).config = { image: `ghcr.io/intentic/sandbox@${STABLE_DIGEST}`, env: { ...currentTunnelEnv(), [ENV_PROJECT_DIR]: FOLDER } };
            const { record, row } = fakeGateRecord({ previousImage: PINNED });
            await rollbackHosted(config(), wakeArgs(), { ...WAKE_TARGET, ...row }, logger, record);
            expect([finalConfigOf(fly).image, ...new Set(foldersWritten(fly))]).toEqual([PINNED, FOLDER]);
        });
    });

    // A probe caught starting or stopping is a gate at work: never started as if it were the sandbox.
    it(`answers busy for a probe caught mid-transition, and starts nothing`, async () => {
        const fly = configuredFly({ [STATE_PROBE_ENV]: PINNED }, `replacing`);
        await expect(wakeHosted(config(), WAKE_TARGET, wakeArgs)).rejects.toBeInstanceOf(HostedMachineBusy);
        expect(fly.called(`POST`, `/machines/m1/start`)).toEqual([]);
        expect(updatesIn(fly)).toHaveLength(0);
    });

    /* A REBUILD APPLIED WHILE THE MACHINE SLEPT IS ON TRIAL, and the wake is its first start: judged like any image
     * change's, and a version that does not come up goes back to the one before it, which is still a woken machine. */
    describe(`an image on trial`, () => {
        const OVERLAY = `registry.fly.io/intentic-sbx-a@sha256:${`c`.repeat(64)}`;
        const onTrial = () => {
            const fly = configuredFly(currentTunnelEnv());
            machineIn(fly).config = { image: OVERLAY, env: currentTunnelEnv() };
            return fly;
        };
        const trialTarget = { ...WAKE_TARGET, image: OVERLAY, environmentHash: `h1`, unprovenImage: OVERLAY };

        it(`goes back to the version before it, freshly configured and running, when its daemon does not come up`, async () => {
            const fly = onTrial();
            fly.commands.answer = machineAnswers({ health: () => healthAnswer({ state: { journal: `failed` } }) });
            const { record, row, prisma } = fakeGateRecord({ image: OVERLAY, environmentHash: `h1`, unprovenImage: OVERLAY, previousImage: PINNED });
            await expect(wakeHosted(config(), trialTarget, wakeArgs, logger, record)).resolves.toBe(false);
            // The stock image it ran before the rebuild, in the config a stock machine gets: no overlay recipe named.
            expect(finalConfigOf(fly).image).toBe(PINNED);
            expect(finalConfigOf(fly).env[`SANDBOX_ENVIRONMENT_HASH`]).toBeUndefined();
            expect(finalConfigOf(fly).env[`INGRESS_URL`]).toBe(testIngressConfig.url);
            expect(runningIn(fly)).toBe(true);
            expect(row).toMatchObject({ image: null, environmentHash: null, unprovenImage: null, previousImage: null });
            // The rebuild that made the image says why it was not kept, where the owner reads a build's fate.
            expect(prisma.hostedBuild.updateMany).toHaveBeenCalledWith({
                where: { hostedMachineId: `h1`, digest: `sha256:${`c`.repeat(64)}` },
                data: {
                    error: `built, but the machine could not be switched to it: the new version did not come up, so the sandbox was put back on the version it had: it could not convert this sandbox's stored files, and put them back as they were`,
                },
            });
        });

        it(`keeps it once its daemon comes up, with the version before it as the way back`, async () => {
            const fly = onTrial();
            fly.commands.answer = machineAnswers({});
            const { record, row } = fakeGateRecord({ image: OVERLAY, environmentHash: `h1`, unprovenImage: OVERLAY, previousImage: PINNED });
            await expect(wakeHosted(config(), trialTarget, wakeArgs, logger, record)).resolves.toBe(false);
            expect(finalConfigOf(fly).image).toBe(OVERLAY);
            expect(execsIn(fly)).toEqual([`health`]);
            expect(row).toMatchObject({ image: OVERLAY, unprovenImage: null, previousImage: PINNED });
        });
    });
});

/* THE OWNER'S WAY BACK: the image kept before the last change, through the same gate, and pressed again, forward. */
describe(`rollbackHosted`, () => {
    const TODAY = `ghcr.io/intentic/sandbox@${STABLE_DIGEST}`;

    it(`goes back to the kept image, skips the digest it left, and pressed again goes forward`, async () => {
        const fly = configuredFly(currentTunnelEnv());
        machineIn(fly).config = { image: TODAY, env: currentTunnelEnv() };
        const { record, row } = fakeGateRecord({ previousImage: PINNED });
        await rollbackHosted(config(), wakeArgs(), { ...WAKE_TARGET, ...row }, logger, record);
        expect(finalConfigOf(fly).image).toBe(PINNED);
        expect(execsIn(fly)).toEqual([`planner`, `health`]);
        expect(row).toMatchObject({ previousImage: TODAY, skippedDigest: STABLE_DIGEST, unprovenImage: null });

        await rollbackHosted(config(), wakeArgs(), { ...WAKE_TARGET, ...row }, logger, record);
        expect(finalConfigOf(fly).image).toBe(TODAY);
        // Going forward leaves the old digest skipped, which `:stable` does not name: a skip that changes nothing.
        expect(row).toMatchObject({ previousImage: PINNED, skippedDigest: `sha256:${`a`.repeat(64)}` });
    });

    it(`refuses when the row keeps no earlier image, and touches nothing`, async () => {
        const fly = configuredFly(currentTunnelEnv());
        await expect(rollbackHosted(config(), wakeArgs(), WAKE_TARGET, logger, fakeGateRecord().record)).rejects.toBeInstanceOf(HostedNothingKept);
        expect(fly.calls).toEqual([]);
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
        respond: (url: string) =>
            json(url.endsWith(`/volumes`) ? [] : (byApp[Object.keys(byApp).find((app) => url.includes(`/apps/${app}/`)) ?? ``] ?? [])),
    });

    const deleteRoute = { match: (method: string) => method === `DELETE`, respond: () => new Response(``, { status: 202 }) };
    // The tunnel id an app is named for: its name past the prefix.
    const idOf = (app: string): string => app.slice(`intentic-sbx-`.length);
    // A database whose deletion records name these apps' sandboxes, on top of the case's own rows.
    const withDeleted = (apps: readonly string[], over: Record<string, Record<string, ReturnType<typeof jest.fn>>> = {}) =>
        fakePrisma({
            hostedMachine: { findMany: jest.fn().mockResolvedValue([{ appName: `intentic-sbx-live` }]) },
            hostedPoolMachine: { findMany: jest.fn().mockResolvedValue([{ appName: `intentic-sbx-pool-warm1` }]) },
            sandboxTombstone: { findMany: jest.fn().mockResolvedValue(apps.map((app) => ({ tunnelId: idOf(app) }))) },
            ...over,
        });
    const knownRows = withDeleted([]);
    const deletedApps = (calls: { method: string; url: string }[]) => calls.filter((entry) => entry.method === `DELETE`).map((entry) => entry.url);

    it(`destroys only apps THIS platform stamped whose sandbox's deletion is on record`, async () => {
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
                "intentic-sbx-orphan": [flyMachine({ platform: INSTANCE, role: `sandbox` })],
                // Different platform stamp: another deployment's machine in the same org/prefix must be left standing,
                // whatever this database's records say about a sandbox of that name.
                "intentic-sbx-stranger": [flyMachine({ platform: `deadbeefcafe`, role: `sandbox` })],
                // No stamp: predates the rule or an unupdated deployment; left standing, flagged by the health sweep
                // instead.
                "intentic-sbx-unstamped": [flyMachine()],
            }),
            deleteRoute,
        ]);
        const report = await reapHostedOrphans(
            withDeleted([`intentic-sbx-orphan`, `intentic-sbx-stranger`, `intentic-sbx-unstamped`]) as never,
            config(),
            logger,
        );
        const deleted = deletedApps(calls);
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toContain(`intentic-sbx-orphan`);
        expect(report).toMatchObject({ destroyed: [`intentic-sbx-orphan`], forgotten: [], skipped: { theirs: 1, unknown: 1 } });
        // Prefix is the jurisdiction: an app outside it is never even queried.
        expect(calls.some((entry) => entry.url.includes(`unrelated-app`))).toBe(false);
    });

    // Absence is not deletion. A platform restored from an older backup has no row and no record for every sandbox made
    // since, and their apps are those sandboxes' disks: reported for an operator, never destroyed.
    it(`leaves an app of ours standing when no deletion record names its sandbox, and reports it as forgotten`, async () => {
        const calls = stubFetch([
            appList(`intentic-sbx-orphan`),
            machinesOf({ "intentic-sbx-orphan": [flyMachine({ platform: INSTANCE, role: `sandbox` })] }),
            deleteRoute,
        ]);
        const report = await reapHostedOrphans(knownRows as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
        expect(report).toMatchObject({ destroyed: [], forgotten: [`intentic-sbx-orphan`], skipped: { forgotten: 1 } });
    });

    it(`spares the app of a deleted sandbox still inside its recovery window`, async () => {
        const calls = stubFetch([
            appList(`intentic-sbx-deleted`),
            // Stamped ours, holding no machine row, its sandbox deleted: without the trash read this is the reaper's
            // clearest orphan, and destroying it would take the volume the owner can still restore from.
            machinesOf({ "intentic-sbx-deleted": [flyMachine({ platform: INSTANCE, role: `sandbox` })] }),
            deleteRoute,
        ]);
        const held = withDeleted([`intentic-sbx-deleted`], {
            sandboxTrash: { findMany: jest.fn().mockResolvedValue([{ appName: `intentic-sbx-deleted` }]) },
        });
        await reapHostedOrphans(held as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
    });

    it(`reads an app holding only a builder as its own: a build stamp proves ownership like any other`, async () => {
        const calls = stubFetch([
            appList(`intentic-sbx-leftover-builder`),
            machinesOf({ "intentic-sbx-leftover-builder": [flyMachine({ platform: INSTANCE, role: `build` })] }),
            deleteRoute,
        ]);
        await reapHostedOrphans(withDeleted([`intentic-sbx-leftover-builder`]) as never, config(), logger);
        const deleted = deletedApps(calls);
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toContain(`intentic-sbx-leftover-builder`);
    });

    // Warm stock carries no person's work (a claim re-stamps its machine `sandbox` first), so its stamp is evidence of
    // its own: a pool build whose cleanup failed is collected without any record.
    it(`collects warm stock nobody claimed, with no record needed`, async () => {
        const calls = stubFetch([
            appList(`intentic-sbx-lost-stock`),
            machinesOf({ "intentic-sbx-lost-stock": [flyMachine({ platform: INSTANCE, role: `warm` })] }),
            deleteRoute,
        ]);
        await reapHostedOrphans(knownRows as never, config(), logger);
        expect(deletedApps(calls)).toEqual([expect.stringContaining(`intentic-sbx-lost-stock`)]);
    });

    it(`leaves a young app alone: a provision in flight owns Fly resources before its row exists`, async () => {
        const calls = stubFetch([
            appList(`intentic-sbx-newborn`),
            machinesOf({ "intentic-sbx-newborn": [flyMachine({ platform: INSTANCE, ageMinutes: 2 })] }),
            deleteRoute,
        ]);
        await reapHostedOrphans(withDeleted([`intentic-sbx-newborn`]) as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
    });

    // App's volumes with an age, to distinguish the two verdicts for an app holding no machine.
    const volumesAged = (ageMinutes: number) => ({
        match: (method: string, url: string) => method === `GET` && url.endsWith(`/volumes`),
        respond: () => json([{ id: `vol_1`, created_at: new Date(Date.now() - ageMinutes * 60_000).toISOString() }]),
    });
    const noMachines = { match: (method: string, url: string) => method === `GET` && url.endsWith(`/machines`), respond: () => json([]) };

    it(`collects an app holding no machine once its sandbox's deletion is on record`, async () => {
        const calls = stubFetch([appList(`intentic-sbx-hollow`), noMachines, volumesAged(120), deleteRoute]);
        await reapHostedOrphans(withDeleted([`intentic-sbx-hollow`]) as never, config(), logger);
        const deleted = deletedApps(calls);
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toContain(`intentic-sbx-hollow`);
    });

    // (2026-10-05) Emptiness used to be its own evidence. It is exactly what Fly losing a machine leaves of a sandbox
    // nobody deleted, once its row has been dropped too: a volume, which is that sandbox's disk.
    it(`keeps an empty app no deletion record explains: its volume may be a sandbox's only disk`, async () => {
        const calls = stubFetch([appList(`intentic-sbx-hollow`), noMachines, volumesAged(120), deleteRoute]);
        const report = await reapHostedOrphans(knownRows as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
        expect(report.forgotten).toEqual([`intentic-sbx-hollow`]);
    });

    // Fly lost the machine and the platform dropped its row (`forgetHostedMachine`): what is left is the sandbox's own
    // disk, and the sandbox row still names the app's tunnel id. Collecting it would delete a workspace nobody released.
    it(`never collects an empty app whose sandbox still exists: its volume is that sandbox's disk`, async () => {
        const calls = stubFetch([appList(`intentic-sbx-alive`), noMachines, volumesAged(120), deleteRoute]);
        const liveRows = fakePrisma({ sandbox: { findMany: jest.fn().mockResolvedValue([{ tunnelId: `alive` }]) } });
        const report = await reapHostedOrphans(liveRows as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
        expect(report.skipped).toEqual({ live: 1 });
    });

    it(`leaves an empty app whose volume was made minutes ago: that is a provision mid-flight`, async () => {
        const calls = stubFetch([appList(`intentic-sbx-mid-provision`), noMachines, volumesAged(2), deleteRoute]);
        await reapHostedOrphans(withDeleted([`intentic-sbx-mid-provision`]) as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
    });

    // A wrong database (a copy with its own deletions, an unrun migration) can still read as "destroy everything", and a
    // share of the fleet that large is more likely that than litter.
    it(`refuses the whole pass when it would destroy an implausible share of the fleet`, async () => {
        const ours = Array.from({ length: 8 }, (_, index) => `intentic-sbx-k${index}z`);
        const calls = stubFetch([
            appList(...ours),
            machinesOf(Object.fromEntries(ours.map((app) => [app, [flyMachine({ platform: INSTANCE, role: `sandbox` })]]))),
            deleteRoute,
        ]);
        // No rows, and a deletion record for every app's sandbox: everything looks collectable.
        const everything = fakePrisma({
            hostedMachine: { findMany: jest.fn().mockResolvedValue([]) },
            sandboxTombstone: { findMany: jest.fn().mockResolvedValue(ours.map((app) => ({ tunnelId: idOf(app) }))) },
        });
        const report = await reapHostedOrphans(everything as never, config(), logger);
        expect(deletedApps(calls)).toHaveLength(0);
        expect(report.refused).toHaveLength(8);
    });

    // (2026-10-05) A backlog past the cap used to refuse the whole pass, so after an outage the reaper never caught up.
    it(`destroys the oldest collectable apps up to its cap and defers the rest to the next pass`, async () => {
        // Forty apps, thirty-four of them rows: a cap of four (a tenth of the fleet), and six collectable, well under the
        // quarter that would read as a wrong database.
        const known = Array.from({ length: 34 }, (_, index) => `intentic-sbx-row${index}z`);
        const gone = Array.from({ length: 6 }, (_, index) => `intentic-sbx-k${index}z`);
        const calls = stubFetch([
            appList(...known, ...gone),
            // k0z is the newest and k5z the oldest: ages climb with the index.
            machinesOf(
                Object.fromEntries(
                    gone.map((app, index) => [app, [flyMachine({ platform: INSTANCE, role: `sandbox`, ageMinutes: 120 + index * 60 })]]),
                ),
            ),
            deleteRoute,
        ]);
        const prisma = fakePrisma({
            hostedMachine: { findMany: jest.fn().mockResolvedValue(known.map((appName) => ({ appName }))) },
            sandboxTombstone: { findMany: jest.fn().mockResolvedValue(gone.map((app) => ({ tunnelId: idOf(app) }))) },
        });
        const report = await reapHostedOrphans(prisma as never, config(), logger);
        expect(report.destroyed).toEqual([`intentic-sbx-k5z`, `intentic-sbx-k4z`, `intentic-sbx-k3z`, `intentic-sbx-k2z`]);
        expect(report.deferred).toEqual([`intentic-sbx-k1z`, `intentic-sbx-k0z`]);
        expect(deletedApps(calls)).toHaveLength(4);
    });

    it(`does nothing when the lane is off`, async () => {
        const fetchSpy = stubFetch([]);
        const report = await reapHostedOrphans(fakePrisma({}) as never, config({ hosted: { ...config().hosted, flyApiToken: `` } }), logger);
        expect(fetchSpy).toHaveLength(0);
        expect(report.destroyed).toEqual([]);
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
        expect(off).toEqual({ enabled: false, remaining: 0, projects: true });
        const on = await call(sandboxRoutes.hostedOffer, undefined, {
            context: routeContext({ prisma: fakePrisma({ hostedMachine: { count: jest.fn().mockResolvedValue(0) } }) }),
        });
        // Ceiling is surfaced before any of it is spent, so the offer card doesn't say "free" and correct itself later.
        expect(on).toEqual({ enabled: true, projects: true, remaining: 1, hours: { allowance: 40, remaining: 40 } });
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
            projects: true,
            remaining: 1,
            hours: { allowance: config().hosted.monthlyHours, remaining: config().hosted.monthlyHours },
        });
        const uncapped = routeContext({
            prisma: fakePrisma({ hostedMachine: { count: jest.fn().mockResolvedValue(0) } }),
            config: config({ hosted: { ...config().hosted, monthlyHours: 0 } }),
        });
        expect(await call(sandboxRoutes.hostedOffer, undefined, { context: uncapped })).toEqual({ enabled: true, remaining: 1, projects: true });
        // Where the plan is actually for sale, the same owner is told they're on it (`plan: true`), distinguishing this
        // from the uncapped case above.
        const selling = routeContext({
            prisma: member,
            config: config({ hostedPlan: { ...config().hostedPlan, stripeSecretKey: `sk`, stripePrices: `${ENTRY.id}=price_${ENTRY.id}` } }),
        });
        expect(await call(sandboxRoutes.hostedOffer, undefined, { context: selling })).toEqual({
            enabled: true,
            projects: true,
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
            hostedUsage: { groupBy: jest.fn().mockResolvedValue([{ sandboxId: `s1`, tier: FREE_TIER.id, _sum: { minutes: 40 * 60 } }]) },
        });
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: spent }) })).rejects.toMatchObject({
            code: `PAYMENT_REQUIRED`,
        });
        expect(fetchSpy).toHaveLength(0);
    });

    /* A PAID SLOT'S HOURS ARE ITS MACHINE'S. The account's free hours, spent, refuse a free machine's wake; a machine
     * standing on a held Standard slot spends its own month instead, and wakes. The same machine with the slot gone
     * (a plan that stopped paying) spends the free hours again, and is refused with them. */
    it(`wakes a machine on a held paid slot past the free hours, and refuses it once the slot is gone`, async () => {
        stubFetch([{ match: (method, url) => method === `POST` && url.endsWith(`/start`), respond: () => json({ ok: true }) }]);
        const spent = (tier: string, plan: { status: string; items: { tier: string; quantity: number }[] }) =>
            fakePrisma({
                sandbox: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: `s1`,
                        ownerId: `u1`,
                        hosted: { id: `h1`, sandboxId: `s1`, tier, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt: null },
                    }),
                },
                // The forty free hours, spent on this machine before it moved up a rung.
                hostedUsage: {
                    groupBy: jest.fn().mockResolvedValue([{ sandboxId: `s1`, tier: FREE_TIER.id, _sum: { minutes: FREE_TIER.monthlyHours * 60 } }]),
                },
                hostedPlan: { findUnique: jest.fn().mockResolvedValue(plan) },
                // The account's one machine as the meter reads it, and the row the wake opens its stretch on.
                hostedMachine: {
                    findMany: jest.fn().mockResolvedValue([{ sandboxId: `s1`, tier, wokeAt: null }]),
                    findUnique: jest.fn().mockResolvedValue({ wokeAt: null }),
                },
            });
        const slot = { status: `active`, items: [{ tier: PAID.id, quantity: 1 }] };
        await expect(call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: spent(FREE_TIER.id, slot) }) })).rejects.toThrow(
            /free hosted hours of this sandbox's owner are used up/u,
        );
        expect(await call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: spent(PAID.id, slot) }) })).toEqual({
            ok: true,
        });
        await expect(
            call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: routeContext({ prisma: spent(PAID.id, { ...slot, status: `past_due` }) }) }),
        ).rejects.toMatchObject({ code: `PAYMENT_REQUIRED` });
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

    // Refused at the door, before anything is read or made: which folder names may reach a machine is the contract's call.
    it(`hostedProvision refuses a project folder ic would refuse, before reading anything`, async () => {
        const fetchSpy = stubFetch([]);
        const findFirst = jest.fn().mockResolvedValue(ownedRow);
        const prisma = fakePrisma({ sandbox: { findFirst } });
        await expect(
            call(sandboxRoutes.hostedProvision, { sandboxId: `s1`, token: `t0k3n`, project: `public` }, { context: routeContext({ prisma }) }),
        ).rejects.toMatchObject({ code: `BAD_REQUEST` });
        expect({ fetched: fetchSpy.length, read: findFirst.mock.calls.length }).toEqual({ fetched: 0, read: 0 });
    });

    /* A PROJECT'S MACHINE is built to order, never claimed from warm stock, whose prewarm boot put the starter site on its
     * volume; and it boots with the folder the editor named. */
    it(`hostedProvision builds a project's machine to order, booting with its folder`, async () => {
        const calls = stubFetch([
            {
                match: (method, url) => method === `GET` && url.endsWith(`/api/v2/namespaces`),
                respond: () => json([{ namespaceToken: `ns-1`, name: `public`, open: true }]),
            },
            { match: (method, url) => method === `POST` && url.endsWith(`/apps`), respond: () => json({ id: `app1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/volumes`), respond: () => json({ id: `vol_1` }) },
            { match: (method, url) => method === `POST` && url.includes(`/machines`), respond: () => json({ id: `m1`, state: `created` }) },
        ]);
        const stock = jest.fn().mockResolvedValue([]);
        const create = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue(ownedRow),
                findUniqueOrThrow: jest.fn().mockResolvedValue({ ...ownedRow, hosted: { region: `iad`, warm: false } }),
            },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), create },
            hostedPoolMachine: { findMany: stock },
        });
        await call(sandboxRoutes.hostedProvision, { sandboxId: `s1`, token: `t0k3n`, project: `my-app` }, { context: routeContext({ prisma }) });
        expect(stock).not.toHaveBeenCalled();
        expect(calls.find((entry) => entry.method === `POST` && entry.url.includes(`/machines`))?.body).toMatchObject({
            config: { env: { [ENV_PROJECT_DIR]: `${WORKSPACE_ROOT}/my-app` } },
        });
        expect(create.mock.calls[0]?.[0]).toMatchObject({ data: { sandboxId: `s1`, warm: false } });
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
            projects: true,
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
            projects: true,
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
        // The one call is the read of whether this sandbox's own app is still there (hosted.ts heldAppOf); nothing is made.
        expect(fetchSpy.filter((entry) => entry.method !== `GET`)).toHaveLength(0);
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
        expect(summary.hosted).toEqual({ region: `iad`, warm: true, canRollBack: false });
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
        expect(summary.hosted).toEqual({ region: `iad`, warm: true, canRollBack: false });
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
                findUniqueOrThrow: jest
                    .fn()
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
        const update = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow), findUnique: checkingIn({ tokenDigest: sha256Hex(`t0k3n`) }) },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue(hosted), update },
        });

        expect(await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ ok: true });
        // Today's stock digest, on the same volume, with this sandbox's identity; the planner was asked first, and the new
        // daemon once it ran.
        const applied = finalConfigOf(fly);
        expect(applied.image).toBe(`ghcr.io/intentic/sandbox@${STABLE_DIGEST}`);
        expect(applied.mounts).toEqual([{ volume: `vol_1`, path: `/data` }]);
        expect(applied.env[`CONNECT_TOKEN`]).toBe(`t0k3n`);
        expect(applied.env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        expect(execsIn(fly)).toEqual([`planner`, `health`]);
        // The digest it ran before is the way back the owner's rollback takes.
        expect(update).toHaveBeenCalledWith({
            where: { id: `h1` },
            data: {
                previousImage: PINNED,
                previousEnvironmentHash: null,
                unprovenImage: null,
                skippedDigest: null,
                image: null,
                environmentHash: null,
                baseImage: null,
                baseDigest: null,
            },
        });
        // Restart replaces the config too, so it must observe the machine running rather than merely asking it to.
        const lastUpdate = fly.calls.findLastIndex((entry) => entry.method === `POST` && entry.path.endsWith(`/machines/m1`));
        expect(fly.calls.findLastIndex((entry) => entry.path.endsWith(`/machines/m1/start`))).toBeGreaterThan(lastUpdate);
        expect(runningIn(fly)).toBe(true);
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: `h1` }, data: expect.objectContaining({ wokeAt: expect.any(Date) }) }),
        );
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
        const refused = await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) }).catch(
            (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(ORPCError);
        expect(refused).toMatchObject({
            code: `CONFLICT`,
            message: `intentic 9.9.9 cannot convert this sandbox's stored state, so the update was stopped before it began and the sandbox stays on the version it had (notes/theme.json: theme: not a colour)`,
        });
        expect(finalConfigOf(fly).image).toBe(PINNED);
        expect(finalConfigOf(fly).env[STATE_PROBE_ENV]).toBeUndefined();
        expect(runningIn(fly)).toBe(true);
        expect(stretch).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: `h1` }, data: expect.objectContaining({ wokeAt: expect.any(Date) }) }),
        );
    });

    /* A RESTART MUST NOT SILENTLY UNDO A ROLLBACK. The owner went back from today's `:stable`; while `:stable` still
     * names it, a restart keeps the version the machine runs, and once it names another, moves as always. */
    it(`hostedRestart keeps the version the owner went back to while :stable still names the one they left`, async () => {
        const fly = configuredFly(currentTunnelEnv(), `started`);
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow), findUnique: checkingIn({ tokenDigest: sha256Hex(`t0k3n`) }) },
            hostedMachine: {
                findUnique: jest.fn().mockResolvedValue({ ...RESTART_ROW, skippedDigest: STABLE_DIGEST }),
                update: jest.fn().mockResolvedValue({}),
            },
        });
        expect(await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ ok: true });
        expect(finalConfigOf(fly).image).toBe(PINNED);
        expect(finalConfigOf(fly).env[`CONNECT_TOKEN`]).toBe(`t0k3n`);
        // Its own digest converts nothing and is not on trial: nothing was asked of a planner or a daemon.
        expect(execsIn(fly)).toEqual([]);
        expect(runningIn(fly)).toBe(true);
    });

    it(`hostedRestart moves as always once :stable names another digest than the one skipped`, async () => {
        const fly = configuredFly(currentTunnelEnv(), `started`);
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow), findUnique: checkingIn({ tokenDigest: sha256Hex(`t0k3n`) }) },
            hostedMachine: {
                findUnique: jest.fn().mockResolvedValue({ ...RESTART_ROW, skippedDigest: `sha256:${`9`.repeat(64)}` }),
                update: jest.fn().mockResolvedValue({}),
            },
        });
        expect(await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ ok: true });
        expect(finalConfigOf(fly).image).toBe(`ghcr.io/intentic/sandbox@${STABLE_DIGEST}`);
    });

    // The platform's own act: it needs nothing of the daemon, and says so before it stops anything.
    it(`hostedRollback answers CONFLICT when no earlier image is kept, and stops nothing`, async () => {
        const fetchSpy = stubFetch([]);
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow) },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue({ ...RESTART_ROW, previousImage: null }) },
        });
        await expect(call(sandboxRoutes.hostedRollback, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).rejects.toMatchObject({
            code: `CONFLICT`,
            message: `this sandbox has no earlier version kept to go back to`,
        });
        expect(fetchSpy).toHaveLength(0);
    });

    it(`hostedRollback goes back to the image kept before the last change, through the gate, and meters the run`, async () => {
        const fly = configuredFly(currentTunnelEnv(), `started`);
        machineIn(fly).config = { image: `ghcr.io/intentic/sandbox@${STABLE_DIGEST}`, env: currentTunnelEnv() };
        const update = jest.fn().mockResolvedValue({});
        const row = {
            ...RESTART_ROW,
            cpuKind: `shared`,
            cpus: 2,
            memoryMb: 4096,
            volumeGb: 10,
            image: null,
            previousImage: PINNED,
            previousEnvironmentHash: null,
        };
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow), findUnique: checkingIn({ tokenDigest: sha256Hex(`t0k3n`) }) },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue(row), update },
        });
        expect(await call(sandboxRoutes.hostedRollback, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ ok: true });
        // The kept digest, in the fresh config a restart writes; its planner asked, and its daemon waited for.
        expect(finalConfigOf(fly).image).toBe(PINNED);
        expect(finalConfigOf(fly).env[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        expect(execsIn(fly)).toEqual([`planner`, `health`]);
        expect(runningIn(fly)).toBe(true);
        // The digest it left is the way forward, and skipped by restarts while `:stable` still names it.
        expect(update).toHaveBeenCalledWith({
            where: { id: `h1` },
            data: {
                previousImage: `ghcr.io/intentic/sandbox@${STABLE_DIGEST}`,
                previousEnvironmentHash: null,
                unprovenImage: null,
                skippedDigest: STABLE_DIGEST,
                image: null,
                environmentHash: null,
                baseImage: null,
                baseDigest: null,
            },
        });
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: `h1` }, data: expect.objectContaining({ wokeAt: expect.any(Date) }) }),
        );
    });

    it(`says a hosted machine can go back once the platform kept the image it ran before`, async () => {
        stubFetch([]);
        const prisma = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue(ownedRow),
                findUniqueOrThrow: jest.fn().mockResolvedValue({ ...ownedRow, hosted: { region: `iad`, warm: false, previousImage: PINNED } }),
            },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue({ appName: `intentic-sbx-a`, machineId: `m1` }), count: jest.fn() },
        });
        const summary = await call(sandboxRoutes.hostedProvision, { sandboxId: `s1`, token: `t0k3n` }, { context: routeContext({ prisma }) });
        expect(summary.hosted).toEqual({ region: `iad`, warm: false, canRollBack: true });
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

    // The machine is gone and the app, with its volume, is not: the restart's replacement adopts the disk (hosted.ts
    // adoptHostedApp) instead of failing at createApp on a name that exists.
    it(`hostedRestart adopts the sandbox's own app and its disk when only the machine is gone`, async () => {
        const own = `intentic-sbx-${sandboxIdFromToken(`t0k3n`)}`;
        const machineCreate = jest.fn().mockResolvedValue({});
        let row: Record<string, unknown> | null = {
            id: `h1`,
            appName: own,
            machineId: `m1`,
            volumeId: `vol_1`,
            region: `iad`,
            wokeAt: null,
            tier: `free`,
        };
        const calls = stubFetch([
            {
                match: (method, url) => method === `POST` && url.endsWith(`/machines/m1/stop`),
                respond: () => json({ error: `machine not found` }, 404),
            },
            { match: (method, url) => method === `GET` && url.includes(`/machines/m1`), respond: () => json({ error: `machine not found` }, 404) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ error: `machine not found` }, 404) },
            {
                match: (method, url) => method === `GET` && url.endsWith(`/api/v2/namespaces`),
                respond: () => json([{ namespaceToken: `ns-1`, name: `public`, open: true }]),
            },
            { match: (method, url) => method === `GET` && url.endsWith(`/apps/${own}`), respond: () => json({ name: own }) },
            { match: (method, url) => method === `GET` && url.endsWith(`/apps/${own}/machines`), respond: () => json([]) },
            {
                match: (method, url) => method === `GET` && url.endsWith(`/apps/${own}/volumes`),
                respond: () => json([{ id: `vol_1`, region: `iad`, size_gb: 10 }]),
            },
            {
                match: (method, url) => method === `POST` && url.endsWith(`/apps/${own}/machines`),
                respond: () => json({ id: `m2`, state: `created` }),
            },
        ]);
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(ownedRow) },
            hostedMachine: {
                findUnique: jest.fn(async () => row),
                create: machineCreate,
                delete: jest.fn(async () => {
                    row = null;
                    return {};
                }),
                update: jest.fn().mockResolvedValue({}),
            },
        });
        expect(await call(sandboxRoutes.hostedRestart, { sandboxId: `s1` }, { context: routeContext({ prisma }) })).toEqual({ ok: true });
        expect(machineCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ machineId: `m2`, volumeId: `vol_1`, appName: own }) });
        expect(calls.some((entry) => entry.method === `POST` && (entry.url.endsWith(`/apps`) || entry.url.endsWith(`/volumes`)))).toBe(false);
        expect(calls.some((entry) => entry.method === `DELETE`)).toBe(false);
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
     * SANDBOX_GRANT and no INGRESS_URL, and with the edge terminating TLS itself its tunnel is the only way in. Its
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
            sandbox: { findFirst: jest.fn().mockResolvedValue(row), findUnique: checkingIn({ tokenDigest: sha256Hex(WAKE_TOKEN) }) },
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
        expect(stretch).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: `h1` }, data: expect.objectContaining({ wokeAt: expect.any(Date) }) }),
        );

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
