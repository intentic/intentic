import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { PrismaClient } from "@intentic-app/prisma";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { testIngressConfig } from "../../testing.js";
import { BUILD_ENV, BUILD_PATHS } from "./hosted-build-script.js";
import {
    buildStateOf,
    HostedBuildRefused,
    hostedBuildStatus,
    rebuildOnMovedBase,
    reconcileHostedBuilds,
    reportHostedBuild,
    requestHostedBuild,
    sweepHostedBuilds,
} from "./hosted-build.js";
import { hostedInstanceId } from "./hosted.js";

/* THE BRAKES, PINNED. Every way a build can cost the platform money has a control in hosted-build.ts, and each
 * one is a test here: a refusal spends nothing (no token minted, no machine made, no row written), a start
 * takes the row's guard first and releases it on failure, a finished build is charged to its owner once and
 * its builder destroyed, and applying an image never starts a stopped machine. The Fly side is a recorded
 * fetch stub; the database is a fake with the answers each case needs. */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const BASE = `ghcr.io/intentic/sandbox:stable`;
const config = (over?: Partial<Config[`hosted`]>): Config =>
    ({
        webOrigin: `https://app.test`,
        google: { clientId: `gcid` },
        api: { url: `https://api.test` },
        secrets: { key: `` },
        // A real signing key: the machine config carries its public half (the owner ticket's), derived at compose.
        ingress: { ...testIngressConfig },
        hosted: {
            flyApiToken: `fly`,
            flyOrg: `intentic`,
            region: `iad`,
            regionEu: `arn`,
            appPrefix: `intentic-sbx`,
            image: BASE,
            cpus: 4,
            memoryMb: 4096,
            volumeGb: 10,
            perUser: 1,
            idleStopMinutes: 20,
            monthlyHours: 40,
            idleDays: 21,
            idleWarnDays: 14,
            poolSize: 1,
            builderImage: `docker.io/moby/buildkit:v0.20.2`,
            builderCpuKind: `shared`,
            builderCpus: 4,
            builderMemoryMb: 4096,
            buildTimeoutMinutes: 30,
            buildsPerDay: 5,
            buildConcurrency: 4,
            buildMinutesPerDay: 600,
            ...over,
        },
        pool: { compEmails: `` },
    }) as unknown as Config;

const OVERLAY = `# Composed by the intentic sandbox daemon: do not edit by hand.\n\nFROM ${BASE}\n\n# ---- custom (owner-approved) ----\nRUN apt-get install -y gnucobol\n`;
const HASH = sha256Hex(OVERLAY);
const DIGEST = `sha256:${`d`.repeat(64)}`;

const owner = { id: `u1`, email: `owner@example.com` };
const machineRow = (over: Record<string, unknown> = {}) => ({
    id: `h1`,
    sandboxId: `s1`,
    appName: `intentic-sbx-abc`,
    machineId: `m1`,
    volumeId: `vol_1`,
    region: `iad`,
    warm: false,
    wokeAt: null,
    idleWarnedAt: null,
    image: null,
    baseImage: null,
    environmentHash: null,
    buildingId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    sandbox: { token: `tok`, owner },
    ...over,
});
const buildRow = (over: Record<string, unknown> = {}) => ({
    id: `b1`,
    hostedMachineId: `h1`,
    hash: HASH,
    baseImage: BASE,
    content: OVERLAY,
    state: `building`,
    image: `registry.fly.io/intentic-sbx-abc:env`,
    digest: null,
    builderMachineId: `mb1`,
    builderInstanceId: `i1`,
    secretHash: sha256Hex(`s3cret`),
    tokenId: `lat-1`,
    requestedBy: owner.email,
    exitCode: null,
    log: null,
    error: null,
    minutes: null,
    // Two and a half minutes ago: rounds up to 3 whatever the clock does between here and the assertion.
    createdAt: new Date(Date.now() - 150_000),
    updatedAt: new Date(),
    finishedAt: null,
    machine: machineRow(),
    ...over,
});

const request = (over: Partial<Parameters<typeof requestHostedBuild>[3]> = {}) => ({
    sandboxId: `s1`,
    ownerId: owner.id,
    ownerEmail: owner.email,
    hash: HASH,
    content: OVERLAY,
    requestedBy: owner.email,
    ...over,
});

/* Every model the module touches, stubbed to the harmless answer. The defaults describe a platform with no
 * build anywhere and an owner with a full month, so each case overrides only the fact it is about. */
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {}) =>
    ({
        membership: { findUnique: vi.fn().mockResolvedValue(null), ...overrides[`membership`] },
        hostedUsage: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}), ...overrides[`hostedUsage`] },
        hostedMachine: {
            findUnique: vi.fn().mockResolvedValue(machineRow()),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            update: vi.fn().mockResolvedValue({}),
            findMany: vi.fn().mockResolvedValue([]),
            ...overrides[`hostedMachine`],
        },
        hostedBuild: {
            count: vi.fn().mockResolvedValue(0),
            aggregate: vi.fn().mockResolvedValue({ _sum: { minutes: null } }),
            findFirst: vi.fn().mockResolvedValue(null),
            findUnique: vi.fn().mockResolvedValue(null),
            findMany: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
                Promise.resolve(
                    buildRow({
                        ...data,
                        createdAt: new Date(),
                        finishedAt: null,
                        exitCode: null,
                        log: null,
                        error: null,
                        minutes: null,
                        digest: null,
                    }),
                ),
            ),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            update: vi.fn().mockResolvedValue({}),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            ...overrides[`hostedBuild`],
        },
    }) as unknown as PrismaClient;

// The two Fly APIs behind one fetch: the Machines REST client and the GraphQL token mint, recorded per call.
const stubFetch = (routes: { match: (method: string, url: string) => boolean; respond: (body: unknown) => Response }[]) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? `GET`;
        const body = typeof init?.body === `string` ? (JSON.parse(init.body) as unknown) : undefined;
        calls.push({ method, url: String(url), body });
        const route = routes.find((candidate) => candidate.match(method, String(url)));
        if (!route) {
            throw new Error(`unexpected fetch: ${method} ${String(url)}`);
        }
        return Promise.resolve(route.respond(body));
    });
    return calls;
};
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

// GraphQL answers by the query's first word, so one route serves the org lookup, the mint and the revoke.
const graphqlRoute = () => ({
    match: (_method: string, url: string) => url === `https://api.fly.io/graphql`,
    respond: (body: unknown) => {
        const { query } = body as { query: string };
        if (query.includes(`organization(slug`)) {
            return json({ data: { organization: { id: `org-node` } } });
        }
        if (query.includes(`createLimitedAccessToken`)) {
            return json({ data: { createLimitedAccessToken: { limitedAccessToken: { id: `lat-1`, token: `fm2_deploy` } } } });
        }
        return json({ data: { deleteLimitedAccessToken: { token: `x` } } });
    },
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`requesting a build: every refusal spends nothing`, () => {
    /* What a refused request leaves behind, measured: the refusal's code, and three counts that must all be
     * zero, Fly calls (no token minted, no machine made), guards taken, rows written. */
    const outcome = async (prisma: PrismaClient, cfg: Config, over: Partial<Parameters<typeof requestHostedBuild>[3]> = {}) => {
        const calls = stubFetch([]);
        const code = await requestHostedBuild(prisma, cfg, logger, request(over)).then(
            () => `started`,
            (error: unknown) => (error instanceof HostedBuildRefused ? error.code : `threw`),
        );
        return {
            code,
            fetches: calls.length,
            guards: (prisma.hostedMachine.updateMany as ReturnType<typeof vi.fn>).mock.calls.length,
            rows: (prisma.hostedBuild.create as ReturnType<typeof vi.fn>).mock.calls.length,
        };
    };
    const refused = (code: string) => ({ code, fetches: 0, guards: 0, rows: 0 });

    it(`is off when the operator set no daily allowance`, async () => {
        expect(await outcome(fakePrisma(), config({ buildsPerDay: 0 }))).toEqual(refused(`off`));
    });

    it(`needs a machine we run`, async () => {
        expect(await outcome(fakePrisma({ hostedMachine: { findUnique: vi.fn().mockResolvedValue(null) } }), config())).toEqual(
            refused(`no-machine`),
        );
    });

    it(`refuses content that no longer hashes to what the owner reviewed`, async () => {
        expect(await outcome(fakePrisma(), config(), { content: `${OVERLAY}RUN echo smuggled\n` })).toEqual(refused(`mismatch`));
    });

    it(`refuses an overlay off the official image, and one with more than RUN/ENV in it`, async () => {
        const foreign = `FROM alpine:3.20\nRUN true\n`;
        expect(await outcome(fakePrisma(), config(), { content: foreign, hash: sha256Hex(foreign) })).toEqual(refused(`invalid`));
        const copying = `FROM ${BASE}\nCOPY . /work\n`;
        expect(await outcome(fakePrisma(), config(), { content: copying, hash: sha256Hex(copying) })).toEqual(refused(`invalid`));
    });

    it(`refuses a second build while one is in flight`, async () => {
        const prisma = fakePrisma({ hostedMachine: { findUnique: vi.fn().mockResolvedValue(machineRow({ buildingId: `b0` })) } });
        expect(await outcome(prisma, config())).toEqual(refused(`busy`));
    });

    it(`refuses past the owner's builds for the day`, async () => {
        const prisma = fakePrisma({ hostedBuild: { count: vi.fn().mockResolvedValueOnce(5).mockResolvedValue(0) } });
        expect(await outcome(prisma, config())).toEqual(refused(`daily`));
    });

    it(`refuses when the platform is building as many as it may at once`, async () => {
        const prisma = fakePrisma({ hostedBuild: { count: vi.fn().mockResolvedValueOnce(0).mockResolvedValue(4) } });
        expect(await outcome(prisma, config())).toEqual(refused(`busy`));
    });

    // Running builds count at the full timeout, so the ceiling holds before they finish.
    it(`refuses when the platform's minutes for the day are spent, counting builds still running`, async () => {
        const prisma = fakePrisma({
            hostedBuild: {
                count: vi.fn().mockResolvedValueOnce(0).mockResolvedValue(3),
                aggregate: vi.fn().mockResolvedValue({ _sum: { minutes: 500 } }),
            },
        });
        // 500 finished + 3 × 30 running + 30 for this one = 620 > 600.
        expect(await outcome(prisma, config())).toEqual(refused(`ceiling`));
    });

    it(`refuses a metered owner whose remaining hours are under the timeout`, async () => {
        const prisma = fakePrisma({ hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 40 * 60 - 10 }), upsert: vi.fn() } });
        expect(await outcome(prisma, config())).toEqual(refused(`budget`));
    });
});

describe(`requesting a build: the start`, () => {
    it(`wins the row's guard, mints an app-scoped token, and creates the builder with the pinned recipe`, async () => {
        const calls = stubFetch([
            graphqlRoute(),
            {
                match: (method, url) => method === `POST` && url.endsWith(`/apps/intentic-sbx-abc/machines`),
                respond: () => json({ id: `mb1`, state: `created`, instance_id: `i1` }),
            },
        ]);
        const prisma = fakePrisma();
        const state = await requestHostedBuild(prisma, config({ image: `ghcr.io/intentic/sandbox:1.60.0` }), logger, request());
        expect(state.state).toBe(`building`);
        expect(state.hash).toBe(HASH);
        // The guard first, by conditional update from null.
        expect(prisma.hostedMachine.updateMany).toHaveBeenCalledWith({
            where: { id: `h1`, buildingId: null },
            data: { buildingId: expect.any(String) },
        });
        // The token: this app, the deploy profile, minutes.
        const mint = calls.find((call) => (call.body as { query?: string } | undefined)?.query?.includes(`createLimitedAccessToken`));
        expect((mint!.body as { variables: { input: Record<string, unknown> } }).variables.input).toMatchObject({
            profile: `deploy`,
            profileParams: { app_id: `intentic-sbx-abc` },
            expiry: `45m`,
        });
        // The builder: buildkit on a shared guest, no volume, no restart, the recipe as files, our stamp.
        const create = calls.find((call) => call.method === `POST` && call.url.endsWith(`/machines`))!.body as {
            name: string;
            region: string;
            config: {
                image: string;
                guest: { cpu_kind: string };
                mounts: unknown[];
                restart: { policy: string };
                files: { guest_path: string; raw_value: string }[];
                env: Record<string, string>;
                init: { entrypoint: string[] };
                metadata: Record<string, string>;
            };
        };
        expect(create.region).toBe(`iad`);
        expect(create.config.image).toBe(`docker.io/moby/buildkit:v0.20.2`);
        expect(create.config.guest.cpu_kind).toBe(`shared`);
        expect(create.config.mounts).toEqual([]);
        expect(create.config.restart).toEqual({ policy: `no` });
        expect(create.config.init).toEqual({ entrypoint: [`/bin/sh`, BUILD_PATHS.script] });
        expect(create.config.metadata).toEqual({ intentic_role: `build`, intentic_sandbox: `s1`, intentic_platform: hostedInstanceId(config()) });
        const files = Object.fromEntries(
            create.config.files.map((file) => [file.guest_path, Buffer.from(file.raw_value, `base64`).toString(`utf8`)]),
        );
        // The FROM is pinned to the image the platform runs, everything else byte-identical to what was approved.
        expect(files[BUILD_PATHS.dockerfile]).toBe(OVERLAY.replace(`FROM ${BASE}`, `FROM ghcr.io/intentic/sandbox:1.60.0`));
        expect(JSON.parse(files[BUILD_PATHS.dockerConfig]!)).toEqual({
            auths: { "registry.fly.io": { auth: Buffer.from(`x:fm2_deploy`).toString(`base64`) } },
        });
        expect(files[BUILD_PATHS.script]).toContain(`buildctl`);
        expect(create.config.env[BUILD_ENV.image]).toBe(`registry.fly.io/intentic-sbx-abc:env`);
        expect(create.config.env[BUILD_ENV.cache]).toBe(`registry.fly.io/intentic-sbx-abc:env-cache`);
        expect(create.config.env[BUILD_ENV.timeoutSeconds]).toBe(`1800`);
        expect(create.config.env[BUILD_ENV.reportUrl]).toMatch(/^https:\/\/api\.test\/sandbox\/hosted-build-report\/[0-9a-f-]+$/);
        // The row: the secret only as its hash, the content as approved, the base the build was pinned to.
        const created = (prisma.hostedBuild.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { data: Record<string, unknown> };
        expect(created.data).toMatchObject({
            state: `building`,
            hash: HASH,
            content: OVERLAY,
            baseImage: `ghcr.io/intentic/sandbox:1.60.0`,
            tokenId: `lat-1`,
            builderMachineId: `mb1`,
        });
        expect(created.data[`secretHash`]).toBe(sha256Hex(create.config.env[BUILD_ENV.secret]!));
        expect(String(created.data[`secretHash`])).not.toBe(create.config.env[BUILD_ENV.secret]);
    });

    it(`releases the guard and destroys the builder when the start fails after the machine was made`, async () => {
        stubFetch([
            graphqlRoute(),
            { match: (method, url) => method === `POST` && url.endsWith(`/machines`), respond: () => json({ id: `mb1`, state: `created` }) },
            { match: (method, url) => method === `DELETE` && url.includes(`/machines/mb1`), respond: () => json({ ok: true }) },
        ]);
        const prisma = fakePrisma({ hostedBuild: { create: vi.fn().mockRejectedValue(new Error(`db down`)) } });
        await expect(requestHostedBuild(prisma, config(), logger, request())).rejects.toThrow(`db down`);
        const releases = (prisma.hostedMachine.updateMany as ReturnType<typeof vi.fn>).mock.calls.map(
            (call) => call[0] as { data: { buildingId: string | null } },
        );
        expect(releases.at(-1)?.data.buildingId).toBeNull();
    });

    it(`answers the standing build for a recipe the machine already runs on the current base`, async () => {
        const calls = stubFetch([]);
        const built = buildRow({ state: `built`, digest: DIGEST, finishedAt: new Date() });
        const prisma = fakePrisma({
            hostedMachine: {
                findUnique: vi
                    .fn()
                    .mockResolvedValue(machineRow({ environmentHash: HASH, baseImage: BASE, image: `registry.fly.io/intentic-sbx-abc@${DIGEST}` })),
            },
            hostedBuild: { findFirst: vi.fn().mockResolvedValue(built) },
        });
        expect((await requestHostedBuild(prisma, config(), logger, request())).state).toBe(`built`);
        expect(calls).toHaveLength(0);
    });

    // A swap, not a build: the same recipe on the same base was built before and its image is still there.
    it(`re-applies an image already built for this recipe and base instead of building it again`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.endsWith(`/machines/m1`), respond: () => json({ id: `m1`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ id: `m1`, state: `stopped` }) },
        ]);
        const built = buildRow({ state: `built`, digest: DIGEST, finishedAt: new Date() });
        const prisma = fakePrisma({ hostedBuild: { findFirst: vi.fn().mockResolvedValue(built) } });
        expect((await requestHostedBuild(prisma, config(), logger, request())).state).toBe(`built`);
        expect(calls.some((call) => call.method === `POST` && call.url.endsWith(`/machines`))).toBe(false);
        const update = calls.find((call) => call.method === `POST` && call.url.endsWith(`/machines/m1`))!.body as {
            config: { image: string; env: Record<string, string> };
        };
        expect(update.config.image).toBe(`registry.fly.io/intentic-sbx-abc@${DIGEST}`);
        expect(update.config.env[`SANDBOX_ENVIRONMENT_HASH`]).toBe(HASH);
        expect(update.config.env[`SANDBOX_BASE_IMAGE`]).toBe(BASE);
        // Stopped stays stopped: no start, so applying a build is never a way around the wake gate.
        expect(calls.some((call) => call.url.endsWith(`/start`))).toBe(false);
    });
});

describe(`the builder's report`, () => {
    const withBuild = (row: ReturnType<typeof buildRow>, over: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {}) =>
        fakePrisma({ ...over, hostedBuild: { findUnique: vi.fn().mockResolvedValue(row), ...over[`hostedBuild`] } });

    it(`answers unknown, forbidden and stale without touching anything`, async () => {
        const calls = stubFetch([]);
        expect(await reportHostedBuild(fakePrisma(), config(), logger, `nope`, `s3cret`, { exitCode: 0, digest: DIGEST, log: `` })).toBe(`unknown`);
        expect(await reportHostedBuild(withBuild(buildRow()), config(), logger, `b1`, `wrong`, { exitCode: 0, digest: DIGEST, log: `` })).toBe(
            `forbidden`,
        );
        expect(
            await reportHostedBuild(withBuild(buildRow({ state: `built` })), config(), logger, `b1`, `s3cret`, {
                exitCode: 0,
                digest: DIGEST,
                log: ``,
            }),
        ).toBe(`stale`);
        expect(calls).toHaveLength(0);
    });

    it(`on success: records the verdict once, charges the minutes, destroys the builder, revokes the token, boots the image`, async () => {
        const calls = stubFetch([
            graphqlRoute(),
            { match: (method, url) => method === `DELETE` && url.includes(`/machines/mb1`), respond: () => json({ ok: true }) },
            { match: (method, url) => method === `GET` && url.endsWith(`/machines/m1`), respond: () => json({ id: `m1`, state: `stopped` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ id: `m1`, state: `stopped` }) },
        ]);
        const prisma = withBuild(buildRow());
        expect(await reportHostedBuild(prisma, config(), logger, `b1`, `s3cret`, { exitCode: 0, digest: DIGEST, log: `#1 DONE\n` })).toBe(`done`);
        const verdict = (prisma.hostedBuild.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
            where: unknown;
            data: Record<string, unknown>;
        };
        expect(verdict.where).toEqual({ id: `b1`, state: `building` });
        expect(verdict.data).toMatchObject({ state: `built`, exitCode: 0, digest: DIGEST, log: `#1 DONE\n`, minutes: 3 });
        // Charged to the owner's month, exactly as a stretch is.
        expect(prisma.hostedUsage.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ create: expect.objectContaining({ userId: `u1`, minutes: 3 }), update: { minutes: { increment: 3 } } }),
        );
        expect(calls.some((call) => call.method === `DELETE` && call.url.endsWith(`/machines/mb1?force=true`))).toBe(true);
        const revoke = calls.find((call) => (call.body as { query?: string } | undefined)?.query?.includes(`deleteLimitedAccessToken`));
        expect((revoke!.body as { variables: unknown }).variables).toEqual({ input: { id: `lat-1` } });
        // The guard released, the machine re-pointed by digest, the row remembering what it runs.
        expect(prisma.hostedMachine.updateMany).toHaveBeenCalledWith({ where: { id: `h1`, buildingId: `b1` }, data: { buildingId: null } });
        const update = calls.find((call) => call.method === `POST` && call.url.endsWith(`/machines/m1`))!.body as {
            config: { image: string; env: Record<string, string> };
        };
        expect(update.config.image).toBe(`registry.fly.io/intentic-sbx-abc@${DIGEST}`);
        expect(update.config.env[`SANDBOX_ENVIRONMENT_HASH`]).toBe(HASH);
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({
            where: { id: `h1` },
            data: { image: `registry.fly.io/intentic-sbx-abc@${DIGEST}`, baseImage: BASE, environmentHash: HASH },
        });
        expect(calls.some((call) => call.url.endsWith(`/start`))).toBe(false);
    });

    it(`on a running machine, waits for the replacement to settle rather than leaving it stopped`, async () => {
        let reads = 0;
        stubFetch([
            graphqlRoute(),
            { match: (method, url) => method === `DELETE` && url.includes(`/machines/mb1`), respond: () => json({ ok: true }) },
            {
                match: (method, url) => method === `GET` && url.endsWith(`/machines/m1`),
                // Running before the update, `replacing` for a read, then started again.
                respond: () => json({ id: `m1`, state: (reads += 1) === 2 ? `replacing` : `started` }),
            },
            { match: (method, url) => method === `POST` && url.endsWith(`/machines/m1`), respond: () => json({ id: `m1`, state: `started` }) },
        ]);
        const prisma = withBuild(buildRow());
        expect(await reportHostedBuild(prisma, config(), logger, `b1`, `s3cret`, { exitCode: 0, digest: DIGEST, log: `` })).toBe(`done`);
        expect(reads).toBeGreaterThanOrEqual(3);
    });

    it(`on failure: records the exit, the log and a reason, charges the minutes, and leaves the machine alone`, async () => {
        const calls = stubFetch([
            graphqlRoute(),
            { match: (method, url) => method === `DELETE` && url.includes(`/machines/mb1`), respond: () => json({ ok: true }) },
        ]);
        const prisma = withBuild(buildRow());
        expect(
            await reportHostedBuild(prisma, config(), logger, `b1`, `s3cret`, {
                exitCode: 100,
                digest: undefined,
                log: `E: Unable to locate package gnucobol\n`,
            }),
        ).toBe(`done`);
        const verdict = (prisma.hostedBuild.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { data: Record<string, unknown> };
        expect(verdict.data).toMatchObject({
            state: `failed`,
            exitCode: 100,
            error: `the build exited 100 without pushing an image`,
            log: `E: Unable to locate package gnucobol\n`,
        });
        expect(prisma.hostedUsage.upsert).toHaveBeenCalledTimes(1);
        expect(calls.some((call) => call.method === `POST` && call.url.endsWith(`/machines/m1`))).toBe(false);
        expect(prisma.hostedMachine.update).toHaveBeenCalledTimes(0);
    });

    // A zero exit with no digest is a builder that did not push: not a success, whatever the code says.
    it(`does not boot an image the builder never named`, async () => {
        stubFetch([graphqlRoute(), { match: (method) => method === `DELETE`, respond: () => json({ ok: true }) }]);
        const prisma = withBuild(buildRow());
        await reportHostedBuild(prisma, config(), logger, `b1`, `s3cret`, { exitCode: 0, digest: undefined, log: `` });
        const verdict = (prisma.hostedBuild.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { data: Record<string, unknown> };
        expect(verdict.data[`state`]).toBe(`failed`);
    });
});

describe(`the reconcile`, () => {
    const building = (over: Record<string, unknown> = {}) =>
        fakePrisma({ hostedBuild: { findMany: vi.fn().mockResolvedValue([buildRow(over)]), findFirst: vi.fn().mockResolvedValue(null) } });
    const appMachines = (ids: string[]) => ({
        match: (method: string, url: string) => method === `GET` && url.endsWith(`/apps/intentic-sbx-abc/machines`),
        respond: () => json(ids.map((id) => ({ id, state: `started`, config: { metadata: {} } }))),
    });

    it(`fails a build whose builder is gone from Fly`, async () => {
        stubFetch([
            graphqlRoute(),
            appMachines([`m1`]),
            { match: (method, url) => method === `GET` && url.endsWith(`/machines/mb1`), respond: () => json({ error: `not found` }, 404) },
            { match: (method) => method === `DELETE`, respond: () => json({ ok: true }) },
        ]);
        const prisma = building();
        await reconcileHostedBuilds(prisma, config(), logger);
        const verdict = (prisma.hostedBuild.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { data: Record<string, unknown> };
        expect(verdict.data).toMatchObject({ state: `failed`, error: `the builder disappeared before it reported` });
    });

    it(`reads the exit off a builder that stopped without reporting, once the report's grace is over`, async () => {
        stubFetch([
            graphqlRoute(),
            appMachines([`m1`, `mb1`]),
            {
                match: (method, url) => method === `GET` && url.endsWith(`/machines/mb1`),
                respond: () =>
                    json({
                        id: `mb1`,
                        state: `stopped`,
                        events: [{ type: `exit`, timestamp: 2, request: { exit_event: { exit_code: 137, oom_killed: true } } }],
                    }),
            },
            { match: (method) => method === `DELETE`, respond: () => json({ ok: true }) },
        ]);
        const prisma = building();
        await reconcileHostedBuilds(prisma, config(), logger);
        const verdict = (prisma.hostedBuild.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { data: Record<string, unknown> };
        expect(verdict.data).toMatchObject({ state: `failed`, exitCode: 137, error: `the builder ran out of memory` });
    });

    it(`leaves a builder that just stopped alone: its report may still be on the way`, async () => {
        stubFetch([
            appMachines([`m1`, `mb1`]),
            {
                match: (method, url) => method === `GET` && url.endsWith(`/machines/mb1`),
                respond: () => json({ id: `mb1`, state: `stopped`, events: [] }),
            },
        ]);
        const prisma = building({ createdAt: new Date(Date.now() - 30_000) });
        await reconcileHostedBuilds(prisma, config(), logger);
        expect(prisma.hostedBuild.updateMany).toHaveBeenCalledTimes(0);
    });

    it(`force-destroys a builder past the timeout and fails the build, capping the minutes it charges`, async () => {
        const calls = stubFetch([
            graphqlRoute(),
            appMachines([`m1`, `mb1`]),
            {
                match: (method, url) => method === `GET` && url.endsWith(`/machines/mb1`),
                respond: () => json({ id: `mb1`, state: `started`, events: [] }),
            },
            { match: (method) => method === `DELETE`, respond: () => json({ ok: true }) },
        ]);
        const prisma = building({ createdAt: new Date(Date.now() - 50 * 60_000) });
        await reconcileHostedBuilds(prisma, config(), logger);
        const verdict = (prisma.hostedBuild.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { data: Record<string, unknown> };
        expect(verdict.data).toMatchObject({ state: `failed`, error: `the build ran past 30 minutes and was stopped`, minutes: 31 });
        expect(calls.some((call) => call.method === `DELETE` && call.url.endsWith(`/machines/mb1?force=true`))).toBe(true);
    });

    it(`leaves a build alone while Fly cannot be asked`, async () => {
        stubFetch([
            appMachines([`m1`, `mb1`]),
            { match: (method, url) => method === `GET` && url.endsWith(`/machines/mb1`), respond: () => json({ error: `boom` }, 500) },
        ]);
        const prisma = building();
        await reconcileHostedBuilds(prisma, config(), logger);
        expect(prisma.hostedBuild.updateMany).toHaveBeenCalledTimes(0);
    });

    // The fleet invariant: while a token is alive, an app holds the sandbox and this build's builder, nothing else.
    it(`destroys a machine nobody made inside a building app`, async () => {
        const calls = stubFetch([
            appMachines([`m1`, `mb1`, `intruder`]),
            { match: (method, url) => method === `DELETE` && url.includes(`/machines/intruder`), respond: () => json({ ok: true }) },
            {
                match: (method, url) => method === `GET` && url.endsWith(`/machines/mb1`),
                respond: () => json({ id: `mb1`, state: `started`, events: [] }),
            },
        ]);
        await reconcileHostedBuilds(building(), config(), logger);
        expect(calls.some((call) => call.method === `DELETE` && call.url.endsWith(`/machines/intruder?force=true`))).toBe(true);
        expect(calls.some((call) => call.method === `DELETE` && call.url.includes(`/machines/mb1`))).toBe(false);
    });

    it(`opens a guard whose build is no longer building`, async () => {
        stubFetch([]);
        const prisma = fakePrisma({
            hostedBuild: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
            hostedMachine: { findMany: vi.fn().mockResolvedValue([{ id: `h1`, buildingId: `b-old` }]) },
        });
        await reconcileHostedBuilds(prisma, config(), logger);
        expect(prisma.hostedMachine.updateMany).toHaveBeenCalledWith({ where: { id: `h1`, buildingId: `b-old` }, data: { buildingId: null } });
    });
});

describe(`a moved base image`, () => {
    it(`rebuilds the recipe a machine runs when the platform's image has moved past its base`, async () => {
        stubFetch([
            graphqlRoute(),
            { match: (method, url) => method === `POST` && url.endsWith(`/machines`), respond: () => json({ id: `mb2`, state: `created` }) },
        ]);
        const prisma = fakePrisma({
            hostedMachine: {
                findUnique: vi
                    .fn()
                    .mockResolvedValue(machineRow({ image: `registry.fly.io/intentic-sbx-abc@${DIGEST}`, baseImage: BASE, environmentHash: HASH })),
            },
            hostedBuild: { findFirst: vi.fn().mockResolvedValueOnce({ hash: HASH, content: OVERLAY }).mockResolvedValue(null) },
        });
        const moved = config({ image: `ghcr.io/intentic/sandbox:1.61.0` });
        await rebuildOnMovedBase(prisma, moved, logger, machineRow({ image: `x`, baseImage: BASE, environmentHash: HASH }), owner);
        const created = (prisma.hostedBuild.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { data: Record<string, unknown> };
        expect(created.data).toMatchObject({ requestedBy: `platform`, baseImage: `ghcr.io/intentic/sandbox:1.61.0`, hash: HASH });
    });

    it(`does nothing for a stock machine or one already on the current base`, async () => {
        const calls = stubFetch([]);
        const prisma = fakePrisma();
        await rebuildOnMovedBase(prisma, config(), logger, machineRow(), owner);
        await rebuildOnMovedBase(prisma, config(), logger, machineRow({ image: `x`, baseImage: BASE, environmentHash: HASH }), owner);
        expect(calls).toHaveLength(0);
        expect(prisma.hostedBuild.findFirst).toHaveBeenCalledTimes(0);
    });
});

describe(`status and retention`, () => {
    it(`answers the latest build and what the machine runs`, async () => {
        const prisma = fakePrisma({
            hostedBuild: {
                findFirst: vi
                    .fn()
                    .mockResolvedValue(buildRow({ state: `failed`, error: `the build exited 1`, log: `boom`, finishedAt: new Date(0) })),
            },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue({ environmentHash: `old` }) },
        });
        const status = await hostedBuildStatus(prisma, `h1`);
        expect(status.applied).toBe(`old`);
        expect(status.build).toMatchObject({
            state: `failed`,
            hash: HASH,
            error: `the build exited 1`,
            log: `boom`,
            finishedAt: `1970-01-01T00:00:00.000Z`,
        });
    });

    it(`maps a row to the card's state`, () => {
        expect(buildStateOf(buildRow() as never)).toMatchObject({ state: `building`, hash: HASH });
        expect(buildStateOf(buildRow({ state: `built` }) as never).state).toBe(`built`);
    });

    it(`drops old rows but keeps the newest built one per machine`, async () => {
        const prisma = fakePrisma({
            hostedBuild: {
                findMany: vi.fn().mockResolvedValue([{ id: `keep-1` }, { id: `keep-2` }]),
                deleteMany: vi.fn().mockResolvedValue({ count: 7 }),
            },
        });
        expect(await sweepHostedBuilds(prisma, () => Date.parse(`2026-09-04T00:00:00Z`))).toBe(7);
        expect(prisma.hostedBuild.deleteMany).toHaveBeenCalledWith({
            where: { createdAt: { lt: new Date(`2026-08-05T00:00:00Z`) }, state: { not: `building` }, id: { notIn: [`keep-1`, `keep-2`] } },
        });
    });

    it(`is a refusal with a code the route can answer with`, () => {
        expect(new HostedBuildRefused(`daily`, `x`).code).toBe(`daily`);
    });
});
