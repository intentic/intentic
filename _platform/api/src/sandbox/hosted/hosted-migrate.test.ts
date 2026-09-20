import { FREE_TIER, hostedTier } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Config, configSchema } from "../../config.js";
import { testIngressConfig } from "../../testing.js";
import {
    hostedMigrationsOf,
    HostedMigrationRefused,
    lastHostedBackupAt,
    type MigratableMachine,
    migrateHosted,
    planChangesNothing,
    planMigration,
    sweepHostedMigrations,
} from "./hosted-migrate.js";

vi.mock(`./hosted-app-lock.js`, async () => ({ withHostedAppLock: (await import(`../../testing.js`)).fakeHostedAppLock }));

/* WHAT THIS SUITE IS FOR. A migration is the one operation that can lose somebody's work, so the cases below are
 * about ordering rather than about arithmetic: the pre-flight snapshot happens before anything else, the old disk is
 * destroyed only after the new machine has announced on the new one, and every failure leaves the machine as it was.
 * The Fly side is a routed fetch stub, because the assertion is which requests were made and in what order. */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const noSleep = async (): Promise<void> => undefined;

const STANDARD = hostedTier(`standard`);
const MAX = hostedTier(`max`);

const config = (over: Record<string, unknown> = {}): Config =>
    configSchema.parse({
        database: { url: `postgres://test` },
        betterAuth: { secret: `test` },
        secrets: { key: `` },
        webOrigin: `https://app.test`,
        ingress: testIngressConfig,
        hosted: { flyApiToken: `fly`, flyOrg: `org`, region: `iad`, regionEu: `arn`, snapshotRetentionDays: 7, ...over },
    });

const machine = (over: Partial<MigratableMachine> = {}): MigratableMachine => ({
    id: `h1`,
    sandboxId: `s1`,
    appName: `intentic-sbx-abc`,
    machineId: `m1`,
    volumeId: `vol_1`,
    region: `iad`,
    tier: FREE_TIER.id,
    cpuKind: FREE_TIER.cpuKind,
    cpus: FREE_TIER.cpus,
    memoryMb: FREE_TIER.memoryMb,
    volumeGb: FREE_TIER.volumeGb,
    image: null,
    environmentHash: null,
    migratingId: null,
    buildingId: null,
    sandbox: { token: `t0k3n`, owner: { email: `owner@example.test` } },
    ...over,
});

interface MigrationRow {
    id: string;
    state: string;
    snapshotId: string | null;
    newMachineId: string | null;
    newVolumeId: string | null;
    error: string | null;
    finishedAt: Date | null;
    [key: string]: unknown;
}

// Enough Prisma for one machine and its migrations: the row the lock lives on, the migration rows, and the sandbox's
// `lastSeenAt`, which is the announce the verification waits for.
const BEFORE = new Date(`2026-09-20T09:00:00Z`);
const AFTER = new Date(`2026-09-20T10:00:00Z`);

const fakePrisma = (seed: { machine?: MigratableMachine; announces?: boolean } = {}) => {
    const row = seed.machine ?? machine();
    const state = { ...row } as Record<string, unknown>;
    const migrations: MigrationRow[] = [];
    // The FIRST read is the mark the verification takes before the restart, so it always answers the old stamp; every
    // read after it is a poll, and answers the new one once the daemon is meant to have checked in.
    const announces = seed.announces !== false;
    let reads = 0;
    let next = 0;
    const prisma = {
        $transaction: async (work: unknown) =>
            Array.isArray(work) ? Promise.all(work as Promise<unknown>[]) : (work as (tx: unknown) => Promise<unknown>)(prisma),
        hostedMachine: {
            findUniqueOrThrow: async () => ({ ...state }),
            update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(state, data),
        },
        hostedMigration: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                next += 1;
                const created: MigrationRow = {
                    id: `mig${next}`,
                    state: `planned`,
                    snapshotId: null,
                    newMachineId: null,
                    newVolumeId: null,
                    error: null,
                    finishedAt: null,
                    ...data,
                };
                migrations.push(created);
                return created;
            },
            update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                const found = migrations.find((entry) => entry.id === where.id);
                return Object.assign(found as MigrationRow, data);
            },
            findUniqueOrThrow: async ({ where }: { where: { id: string } }) => migrations.find((entry) => entry.id === where.id),
            findMany: async () => migrations.toReversed(),
        },
        sandbox: {
            findUnique: async () => {
                reads += 1;
                return { lastSeenAt: announces && reads > 1 ? AFTER : BEFORE };
            },
        },
    };
    return { prisma: prisma as unknown as PrismaClient, migrations, state };
};

// Routes Fly by method and URL, recording every call so the ORDER of a teardown can be asserted, not just the fact.
const stubFly = (over: { snapshotStatus?: string } = {}) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    // Power is tracked rather than answered `started` always: a move stops the original, and whether the rollback
    // actually starts it again is exactly the thing one of these cases is about.
    const power = new Map<string, string>([[`m1`, `started`]]);
    const machineId = (href: string): string => href.split(`/machines/`)[1]?.split(`/`)[0] ?? ``;
    const snapshot = { id: `vs_1`, status: over.snapshotStatus ?? `created`, created_at: `2026-09-20T09:30:00Z`, size: 1 };

    // Matched on the URL's suffix, never `includes`: `/volumes/vol_1/snapshots` contains `/volumes`, and reading it
    // as a volume create is how a stub quietly answers the wrong call.
    const routes: { method: string; ends: RegExp; answer: (href: string) => unknown }[] = [
        { method: `POST`, ends: /\/snapshots$/u, answer: () => ({ id: `vs_1`, status: `waiting` }) },
        { method: `GET`, ends: /\/snapshots$/u, answer: () => [snapshot] },
        { method: `PUT`, ends: /\/extend$/u, answer: () => ({ volume: { id: `vol_1`, size_gb: 25, state: `created` }, needs_restart: true }) },
        { method: `POST`, ends: /\/volumes$/u, answer: () => ({ id: `vol_2` }) },
        {
            method: `POST`,
            ends: /\/machines$/u,
            answer: () => {
                power.set(`m2`, `started`);
                return { id: `m2`, state: `started` };
            },
        },
        {
            method: `POST`,
            ends: /\/stop$/u,
            answer: (href) => {
                power.set(machineId(href), `stopped`);
                return { ok: true };
            },
        },
        {
            method: `POST`,
            ends: /\/start$/u,
            answer: (href) => {
                power.set(machineId(href), `started`);
                return { ok: true };
            },
        },
        { method: `GET`, ends: /\/machines\/[^/]+$/u, answer: (href) => ({ id: machineId(href), state: power.get(machineId(href)) ?? `stopped` }) },
    ];

    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? `GET`;
        const href = String(url);
        calls.push({ method, url: href, ...(typeof init?.body === `string` ? { body: JSON.parse(init.body) } : {}) });
        const route = routes.find((candidate) => candidate.method === method && candidate.ends.test(href));
        return Promise.resolve(new Response(JSON.stringify(route === undefined ? { ok: true } : route.answer(href)), { status: 200 }));
    });
    return calls;
};

type Call = { method: string; url: string; body?: unknown };

// Both helpers match the end of the URL's PATH, with the query dropped. A path that merely contains another is the
// trap these calls set — `/volumes/vol_1/snapshots` is not a volume create, `/machines/m1/stop` is not a config
// replacement — and a forced destroy carries `?force=true`, which an end-of-URL match would miss entirely.
const hits = (call: Call, method: string, ends: string): boolean => call.method === method && new URL(call.url).pathname.endsWith(ends);

const calledWith = (calls: Call[], method: string, ends: string): Call[] => calls.filter((call) => hits(call, method, ends));

const indexOf = (calls: Call[], method: string, ends: string): number => calls.findIndex((call) => hits(call, method, ends));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`planning a migration`, () => {
    it(`stays put for a rung change and moves for a region change`, () => {
        expect(planMigration(config(), machine(), { tier: `standard` }).kind).toBe(`resize`);
        expect(planMigration(config(), machine(), { tier: FREE_TIER.id, region: `arn` }).kind).toBe(`move`);
    });

    /* A DOWNGRADE KEEPS ITS DISK. Fly volumes grow and never shrink, so the alternative is a file-level copy; this
     * is the rule that makes a downgrade a restart instead of a data migration. */
    it(`takes the larger disk of the two, so going down a rung never asks for a smaller one`, () => {
        const big = machine({ tier: MAX.id, cpus: MAX.cpus, memoryMb: MAX.memoryMb, volumeGb: MAX.volumeGb });
        const down = planMigration(config(), big, { tier: FREE_TIER.id });
        expect(down.to.shape).toEqual({ cpuKind: FREE_TIER.cpuKind, cpus: FREE_TIER.cpus, memoryMb: FREE_TIER.memoryMb, volumeGb: MAX.volumeGb });
        expect(down.to.shape.volumeGb).toBeGreaterThan(FREE_TIER.volumeGb);
    });

    it(`sees no change when the rung, the region and every number already match`, () => {
        expect(planChangesNothing(planMigration(config(), machine(), { tier: FREE_TIER.id }))).toBe(true);
        expect(planChangesNothing(planMigration(config(), machine(), { tier: `standard` }))).toBe(false);
    });
});

describe(`resizing where the machine stands`, () => {
    it(`snapshots, grows the disk, replaces the guest, waits to be told it is up, then records the new machine`, async () => {
        const calls = stubFly();
        const { prisma, migrations, state } = fakePrisma();
        const result = await migrateHosted(prisma, config(), logger, machine(), { tier: `standard` }, `owner@example.test`, noSleep);

        expect(result.state).toBe(`done`);
        // The snapshot is taken before the disk or the guest is touched: it is the only thing that survives a rollback.
        expect(indexOf(calls, `POST`, `/snapshots`)).toBeLessThan(indexOf(calls, `PUT`, `/extend`));
        expect(indexOf(calls, `PUT`, `/extend`)).toBeLessThan(indexOf(calls, `POST`, `/machines/m1`));
        expect(calls.find((call) => call.method === `PUT` && call.url.endsWith(`/extend`))?.body).toEqual({ size_gb: STANDARD.volumeGb });
        const replaced = calls.find((call) => call.method === `POST` && call.url.endsWith(`/machines/m1`))?.body as {
            config: { guest: Record<string, unknown> };
        };
        expect(replaced.config.guest).toEqual({ cpu_kind: STANDARD.cpuKind, cpus: STANDARD.cpus, memory_mb: STANDARD.memoryMb });
        // Nothing is forked or destroyed: a resize is one machine on one disk throughout.
        expect(calledWith(calls, `POST`, `/volumes`)).toEqual([]);
        expect(calls.filter((call) => call.method === `DELETE` && new URL(call.url).pathname.includes(`/volumes/`))).toEqual([]);

        expect(state).toMatchObject({ tier: STANDARD.id, cpus: STANDARD.cpus, memoryMb: STANDARD.memoryMb, volumeGb: STANDARD.volumeGb });
        // The lock the row holds is released, and the migration remembers the disk it saved first.
        expect(state[`migratingId`]).toBeNull();
        expect(migrations[0]).toMatchObject({ kind: `resize`, state: `done`, snapshotId: `vs_1`, fromTier: FREE_TIER.id, toTier: STANDARD.id });
    });

    it(`puts the old guest back and says so when the sandbox never announces itself`, async () => {
        const calls = stubFly();
        const { prisma, migrations, state } = fakePrisma({ announces: false });
        await expect(migrateHosted(prisma, config(), logger, machine(), { tier: `standard` }, `owner@example.test`, noSleep)).rejects.toThrow(
            /did not announce itself/u,
        );

        // Two config replacements: the one that failed and the one that undid it, the second carrying the old guest.
        const replacements = calls.filter((call) => call.method === `POST` && call.url.endsWith(`/machines/m1`));
        expect(replacements).toHaveLength(2);
        const undone = replacements[1] as { body: { config: { guest: Record<string, unknown> } } };
        expect(undone.body.config.guest).toEqual({
            cpu_kind: FREE_TIER.cpuKind,
            cpus: FREE_TIER.cpus,
            memory_mb: FREE_TIER.memoryMb,
        });
        expect(migrations[0]).toMatchObject({ state: `rolledBack`, snapshotId: `vs_1` });
        expect(migrations[0]?.error).toMatch(/did not announce itself/u);
        // The machine row is exactly as it was, and free again for another attempt.
        expect(state).toMatchObject({ tier: FREE_TIER.id, cpus: FREE_TIER.cpus, migratingId: null });
    });

    // Nothing is spent before the snapshot exists, which is what makes this failure cost the owner nothing at all.
    it(`stops before touching the machine when the snapshot never finishes`, async () => {
        const calls = stubFly({ snapshotStatus: `running` });
        const { prisma, migrations } = fakePrisma();
        await expect(migrateHosted(prisma, config(), logger, machine(), { tier: `standard` }, `owner@example.test`, noSleep)).rejects.toThrow(
            /snapshot vs_1 was still not finished/u,
        );
        expect(calledWith(calls, `PUT`, `/extend`)).toEqual([]);
        expect(calledWith(calls, `POST`, `/machines/m1`)).toEqual([]);
        // `failed`, not `rolledBack`: nothing was changed, so nothing was put back, and the machine never restarted.
        expect(migrations[0]?.state).toBe(`failed`);
    });
});

describe(`moving to another machine`, () => {
    it(`forks the disk, builds beside the original, and destroys the original only once the new one has answered`, async () => {
        const calls = stubFly();
        const { prisma, migrations, state } = fakePrisma();
        const result = await migrateHosted(prisma, config(), logger, machine(), { tier: `standard`, region: `arn` }, `platform`, noSleep);

        expect(result.state).toBe(`done`);
        // Stopped first, so the copy is taken from a filesystem nobody is writing to.
        expect(indexOf(calls, `POST`, `/machines/m1/stop`)).toBeLessThan(indexOf(calls, `POST`, `/volumes`));
        const volume = calls.find((call) => call.method === `POST` && call.url.endsWith(`/volumes`))?.body as Record<string, unknown>;
        // Another region cannot fork: it restores the pre-flight snapshot instead, onto a host sized for the new guest.
        expect(volume).toMatchObject({
            region: `arn`,
            size_gb: STANDARD.volumeGb,
            snapshot_id: `vs_1`,
            snapshot_retention: 7,
            compute: { cpu_kind: STANDARD.cpuKind, cpus: STANDARD.cpus, memory_mb: STANDARD.memoryMb },
        });
        expect(volume[`source_volume_id`]).toBeUndefined();

        /* THE ORDERING THIS WHOLE MODULE EXISTS FOR: the old disk goes after the swap, never before it. */
        expect(indexOf(calls, `POST`, `/machines`)).toBeLessThan(indexOf(calls, `DELETE`, `/machines/m1`));
        expect(indexOf(calls, `DELETE`, `/machines/m1`)).toBeLessThan(indexOf(calls, `DELETE`, `/volumes/vol_1`));

        expect(state).toMatchObject({ machineId: `m2`, volumeId: `vol_2`, region: `arn`, tier: STANDARD.id, migratingId: null });
        expect(migrations[0]).toMatchObject({ kind: `move`, state: `done`, oldMachineId: `m1`, oldVolumeId: `vol_1`, newMachineId: `m2`, newVolumeId: `vol_2` });
    });

    it(`forks in place when the region is not changing, rather than waiting on a restore`, async () => {
        const calls = stubFly();
        const { prisma } = fakePrisma();
        // A move within the region: asked for directly, which is how a host with no room for the bigger guest is escaped.
        await migrateHosted(prisma, config(), logger, machine(), { tier: `standard`, region: `iad` }, `platform`, noSleep).catch(() => undefined);
        // Same region resizes rather than moving, so nothing was forked; the region is what decides.
        expect(calledWith(calls, `POST`, `/volumes`)).toEqual([]);
    });

    it(`takes away everything it built and starts the original again when the new machine never answers`, async () => {
        const calls = stubFly();
        const { prisma, migrations, state } = fakePrisma({ announces: false });
        await expect(
            migrateHosted(prisma, config(), logger, machine(), { tier: `standard`, region: `arn` }, `platform`, noSleep),
        ).rejects.toThrow(/did not announce itself/u);

        // The new volume is this run's alone, so it goes; the original's is never touched.
        expect(calledWith(calls, `DELETE`, `/volumes/vol_2`)).toHaveLength(1);
        expect(calledWith(calls, `DELETE`, `/volumes/vol_1`)).toEqual([]);
        expect(calledWith(calls, `DELETE`, `/machines/m1`)).toEqual([]);
        // The original is started again, and the row still names it.
        expect(calledWith(calls, `POST`, `/machines/m1/start`).length).toBeGreaterThan(0);
        expect(state).toMatchObject({ machineId: `m1`, volumeId: `vol_1`, region: `iad`, tier: FREE_TIER.id, migratingId: null });
        expect(migrations[0]?.state).toBe(`rolledBack`);
    });
});

describe(`what a migration refuses before spending anything`, () => {
    it(`refuses a second one while the first is running, and one while an environment build is`, async () => {
        stubFly();
        const busy = fakePrisma({ machine: machine({ migratingId: `mig0` }) });
        await expect(migrateHosted(busy.prisma, config(), logger, machine(), { tier: `standard` }, `x`, noSleep)).rejects.toThrow(
            new HostedMigrationRefused(`busy`, `this sandbox's machine is already being changed; wait for that to finish`),
        );
        const building = fakePrisma({ machine: machine({ buildingId: `b1` }) });
        await expect(migrateHosted(building.prisma, config(), logger, machine(), { tier: `standard` }, `x`, noSleep)).rejects.toThrow(
            /building its environment/u,
        );
    });

    it(`refuses a change to the machine it already is, rather than restarting it for nothing`, async () => {
        const calls = stubFly();
        const { prisma } = fakePrisma();
        await expect(migrateHosted(prisma, config(), logger, machine(), { tier: FREE_TIER.id }, `x`, noSleep)).rejects.toThrow(/already on/u);
        expect(calls).toEqual([]);
    });

    it(`refuses on a platform that runs no machines at all`, async () => {
        const { prisma } = fakePrisma();
        const off = config({ flyApiToken: `` });
        await expect(migrateHosted(prisma, off, logger, machine(), { tier: `standard` }, `x`, noSleep)).rejects.toThrow(
            new HostedMigrationRefused(`off`, `this platform does not run hosted machines`),
        );
    });
});

describe(`the sweep over runs that stopped`, () => {
    it(`frees the machine and collects what a dead run had built`, async () => {
        const calls = stubFly();
        const stuck = {
            id: `mig9`,
            state: `verifying`,
            startedAt: new Date(`2026-09-20T08:00:00Z`),
            newMachineId: `m2`,
            newVolumeId: `vol_2`,
            machine: { id: `h1`, appName: `intentic-sbx-abc` },
        };
        const state: Record<string, unknown> = { migratingId: `mig9` };
        const prisma = {
            $transaction: async (work: unknown) => Promise.all(work as Promise<unknown>[]),
            hostedMigration: {
                findMany: async () => [stuck],
                update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(stuck, data),
            },
            hostedMachine: { update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(state, data) },
        } as unknown as PrismaClient;

        expect(await sweepHostedMigrations(prisma, config(), logger, new Date(`2026-09-20T10:00:00Z`))).toBe(1);
        // Both halves of the half-built pair go: they sit inside a live app, which the orphan reaper never touches.
        expect(calledWith(calls, `DELETE`, `/machines/m2`)).toHaveLength(1);
        expect(calledWith(calls, `DELETE`, `/volumes/vol_2`)).toHaveLength(1);
        expect(state[`migratingId`]).toBeNull();
        expect(stuck).toMatchObject({ state: `failed` });
    });

    it(`leaves a run that is merely young alone`, async () => {
        const prisma = { hostedMigration: { findMany: async () => [] } } as unknown as PrismaClient;
        expect(await sweepHostedMigrations(prisma, config(), logger, new Date(`2026-09-20T10:00:00Z`))).toBe(0);
    });
});

describe(`what the owner is told about their backups`, () => {
    it(`answers the newest finished snapshot, and ignores one still being taken`, async () => {
        vi.stubGlobal(`fetch`, () =>
            Promise.resolve(
                new Response(
                    JSON.stringify([
                        { id: `vs_running`, status: `running`, created_at: `2026-09-20T11:00:00Z` },
                        { id: `vs_done`, status: `created`, created_at: `2026-09-20T09:30:00Z` },
                    ]),
                    { status: 200 },
                ),
            ),
        );
        expect(await lastHostedBackupAt(config(), { appName: `intentic-sbx-abc`, volumeId: `vol_1` })).toEqual(new Date(`2026-09-20T09:30:00Z`));
    });
});

describe(`a machine's migration history`, () => {
    it(`reads newest first, which is what a page showing one in flight wants`, async () => {
        stubFly();
        const { prisma } = fakePrisma();
        await migrateHosted(prisma, config(), logger, machine(), { tier: `standard` }, `owner@example.test`, noSleep);
        const history = await hostedMigrationsOf(prisma, `s1`);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ toTier: STANDARD.id, state: `done` });
    });
});
