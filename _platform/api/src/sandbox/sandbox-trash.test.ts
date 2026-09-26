import { installFakeFly } from "@intentic/testing/fly-fake";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { Config } from "../config.js";
import { RECOVERY_WINDOW_MS } from "../durations.js";
import { testIngressConfig } from "../testing.js";
import { listTrash, restoreSandbox, sweepSandboxTrash, TrashedSandboxGone } from "./sandbox-trash.js";

const config = () =>
    ({
        webOrigin: `https://app.test`,
        api: { url: `https://api.test`, trustedIpHeader: `` },
        ingress: { ...testIngressConfig },
        secrets: { key: `` },
        google: { clientId: `gcid` },
        hosted: {
            flyApiToken: `fly`,
            flyOrg: `intentic`,
            region: `iad`,
            appPrefix: `intentic-sbx`,
            image: `registry/base:1`,
            cpus: 2,
            memoryMb: 4096,
            volumeGb: 10,
            perUser: 1,
            idleStopMinutes: 20,
            monthlyHours: 40,
        },
    }) as unknown as Config;

const trashRow = {
    id: `t1`,
    ownerId: `u1`,
    name: `dev`,
    image: null,
    appName: `intentic-sbx-a`,
    machineId: `m1`,
    volumeId: `vol1`,
    region: `iad`,
    flyImage: `registry/overlay:1`,
    baseImage: `registry/base:1`,
    environmentHash: `abc123`,
    tier: `free`,
    cpuKind: `shared`,
    cpus: 2,
    memoryMb: 4096,
    volumeGb: 10,
    deletedAt: new Date(),
    purgeAfter: new Date(Date.now() + RECOVERY_WINDOW_MS),
};

const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof jest.fn>>>) => {
    // The slot write asserts the row still carries the token it was handed, so the fake answers with the digest the
    // mint just wrote rather than a transcribed one.
    let mintedDigest = ``;
    const created = overrides[`sandbox`]?.[`create`] ?? jest.fn().mockResolvedValue({ id: `s2`, name: `dev`, image: null, hosted: null });
    const prisma = {
        ...overrides,
        $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => work(prisma)),
        $queryRaw: jest.fn().mockResolvedValue([]),
        $executeRaw: jest.fn().mockResolvedValue(0),
        sandbox: {
            update: jest.fn().mockResolvedValue({}),
            findUniqueOrThrow: jest.fn().mockResolvedValue({ ownerId: `u1` }),
            ...overrides[`sandbox`],
            create: jest.fn(async (args: { data: { tokenDigest: string } }) => {
                mintedDigest = args.data.tokenDigest;
                return (created as (input: unknown) => Promise<unknown>)(args);
            }),
            findUnique: jest.fn(() => Promise.resolve({ tokenDigest: mintedDigest })),
        },
        user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ email: `owner@example.com` }), ...overrides[`user`] },
        hostedMachine: {
            create: jest.fn().mockResolvedValue({ region: `iad`, warm: false }),
            count: jest.fn().mockResolvedValue(0),
            ...overrides[`hostedMachine`],
        },
        hostedPlan: { findUnique: jest.fn().mockResolvedValue(null), ...overrides[`hostedPlan`] },
        hostedCleanup: { upsert: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({ count: 0 }), ...overrides[`hostedCleanup`] },
        sandboxTrash: {
            findUnique: jest.fn().mockResolvedValue(trashRow),
            findMany: jest.fn().mockResolvedValue([]),
            delete: jest.fn().mockResolvedValue({}),
            ...overrides[`sandboxTrash`],
        },
    };
    return prisma as never;
};

afterEach(() => {
    unstubAllGlobals();
});

/* The shared in-memory Fly, holding the machine a trashed sandbox left behind. A restore must land on THAT machine
 * and that volume, so the fake is seeded with them under the ids the trash row names. */
const stubFly = () => {
    const fly = installFakeFly((name, value) => stubGlobal(name, value));
    const seeded = fly.seedSandbox(`intentic-sbx-a`);
    fly.machines.set(`m1`, { ...seeded.machine, id: `m1`, state: `stopped` });
    fly.machines.delete(seeded.machine.id);
    fly.volumes.set(`vol1`, { ...seeded.volume, id: `vol1` });
    fly.volumes.delete(seeded.volume.id);
    return fly;
};

describe(`listTrash`, () => {
    it(`offers only rows whose window is still open: an expired one promises a recovery nothing can perform`, async () => {
        const findMany = jest.fn().mockResolvedValue([trashRow]);
        const prisma = fakePrisma({ sandboxTrash: { findMany } });
        const rows = await listTrash(prisma, `u1`);
        expect(rows).toEqual([{ id: `t1`, name: `dev`, image: null, deletedAt: trashRow.deletedAt, purgeAfter: trashRow.purgeAfter, hosted: true }]);
        const [[query]] = findMany.mock.calls as [[{ where: { ownerId: string; purgeAfter: { gt: Date } } }]];
        expect(query.where.ownerId).toBe(`u1`);
        expect(query.where.purgeAfter.gt).toBeInstanceOf(Date);
    });

    it(`reads a sandbox that ran on the owner's own computer as carrying no machine to restore`, async () => {
        const ownMachine = { ...trashRow, appName: null, machineId: null, volumeId: null, region: null };
        const prisma = fakePrisma({ sandboxTrash: { findMany: jest.fn().mockResolvedValue([ownMachine]) } });
        expect((await listTrash(prisma, `u1`))[0]?.hosted).toBe(false);
    });
});

describe(`restoreSandbox`, () => {
    it(`refuses a row past its window rather than restoring onto a disk that may already be gone`, async () => {
        const expired = { ...trashRow, purgeAfter: new Date(Date.now() - 1000) };
        const prisma = fakePrisma({ sandboxTrash: { findUnique: jest.fn().mockResolvedValue(expired) } });
        await expect(restoreSandbox(prisma, config(), `u1`, `t1`)).rejects.toBeInstanceOf(TrashedSandboxGone);
    });

    it(`refuses another account's row: a trash id is not a capability`, async () => {
        const prisma = fakePrisma({ sandboxTrash: { findUnique: jest.fn().mockResolvedValue({ ...trashRow, ownerId: `u2` }) } });
        await expect(restoreSandbox(prisma, config(), `u1`, `t1`)).rejects.toBeInstanceOf(TrashedSandboxGone);
    });

    it(`reattaches the preserved machine and pushes the new identity onto it without starting it`, async () => {
        const fly = stubFly();
        const create = jest.fn().mockResolvedValue({ region: `iad`, warm: false });
        const drop = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({ hostedMachine: { create, count: jest.fn().mockResolvedValue(0) }, sandboxTrash: { delete: drop } });
        await restoreSandbox(prisma, config(), `u1`, `t1`);

        // The same app, machine and volume: a restore that provisioned new ones would come back on an empty disk.
        const [[row]] = create.mock.calls as [[{ data: Record<string, unknown> }]];
        expect(row.data).toMatchObject({ appName: `intentic-sbx-a`, machineId: `m1`, volumeId: `vol1`, region: `iad` });
        // The overlay it was built on, so it comes back as the environment it had.
        expect(row.data).toMatchObject({ image: `registry/overlay:1`, environmentHash: `abc123` });
        // A config replacement carries the new connect token; a start would cost uptime the owner did not ask for.
        expect(fly.called(`POST`, `/machines/m1`)).toHaveLength(1);
        expect(fly.called(`POST`, `/machines/m1/start`)).toEqual([]);
        expect(drop).toHaveBeenCalledTimes(1);
        expect(drop).toHaveBeenCalledWith({ where: { id: `t1` } });
    });

    /* A RESTORE IS NOT AN UPDATE. A stock machine comes back on the digest it last ran (the fake reports
     * `sha256:<machine id>`), never on whatever the configured tag names today: the version that wrote its stored
     * state is the one that reads it again, and a later restart moves it under the state gate. */
    it(`brings a stock machine back on the digest it ran, not on today's tag`, async () => {
        const fly = stubFly();
        const create = jest.fn().mockResolvedValue({ region: `iad`, warm: false });
        const prisma = fakePrisma({
            hostedMachine: { create, count: jest.fn().mockResolvedValue(0) },
            sandboxTrash: { findUnique: jest.fn().mockResolvedValue({ ...trashRow, flyImage: null, environmentHash: null }), delete: jest.fn().mockResolvedValue({}) },
        });
        await restoreSandbox(prisma, config(), `u1`, `t1`);
        expect(fly.machines.get(`m1`)?.config[`image`]).toBe(`registry.test/sandbox@sha256:m1`);
        expect(fly.called(`POST`, `/machines/m1/start`)).toEqual([]);
    });

    it(`mints a fresh identity: the deleted sandbox's connect token died with its row`, async () => {
        stubFly();
        const create = jest.fn().mockResolvedValue({ id: `s2`, name: `dev`, image: null, hosted: null });
        const prisma = fakePrisma({
            sandbox: { create, update: jest.fn().mockResolvedValue({}), findUniqueOrThrow: jest.fn().mockResolvedValue({ ownerId: `u1` }) },
        });
        await restoreSandbox(prisma, config(), `u1`, `t1`);
        const [[minted]] = create.mock.calls as [[{ data: { name: string; ownerId: string; tokenDigest: string; tunnelId: string } }]];
        expect(minted.data).toMatchObject({ name: `dev`, ownerId: `u1` });
        expect(minted.data.tunnelId).not.toBe(``);
    });

    it(`brings back an own-machine sandbox as a name and a setup to re-run, touching no provider`, async () => {
        const fly = stubFly();
        const ownMachine = { ...trashRow, appName: null, machineId: null, volumeId: null, region: null };
        const drop = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({ sandboxTrash: { findUnique: jest.fn().mockResolvedValue(ownMachine), delete: drop } });
        await restoreSandbox(prisma, config(), `u1`, `t1`);
        expect(fly.calls).toHaveLength(0);
        expect(drop).toHaveBeenCalledTimes(1);
        expect(drop).toHaveBeenCalledWith({ where: { id: `t1` } });
    });
});

describe(`sweepSandboxTrash`, () => {
    it(`hands an expired row's app to the teardown queue and drops the row`, async () => {
        const upsert = jest.fn().mockResolvedValue({});
        const drop = jest.fn().mockResolvedValue({});
        const findMany = jest.fn().mockResolvedValue([{ id: `t1`, appName: `intentic-sbx-a` }]);
        const prisma = fakePrisma({ hostedCleanup: { upsert }, sandboxTrash: { findMany, delete: drop } });
        expect(await sweepSandboxTrash(prisma)).toEqual({ purged: 1 });

        const [[query]] = findMany.mock.calls as [[{ where: { purgeAfter: { lte: Date } } }]];
        expect(query.where.purgeAfter.lte).toBeInstanceOf(Date);
        // No `deleteAfter`: this teardown is already overdue, unlike a release's, which starts its own window.
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(upsert).toHaveBeenCalledWith({ where: { appName: `intentic-sbx-a` }, create: { appName: `intentic-sbx-a` }, update: {} });
        expect(drop).toHaveBeenCalledTimes(1);
        expect(drop).toHaveBeenCalledWith({ where: { id: `t1` } });
    });

    it(`queues nothing for a sandbox that held no machine`, async () => {
        const upsert = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            hostedCleanup: { upsert },
            sandboxTrash: { findMany: jest.fn().mockResolvedValue([{ id: `t1`, appName: null }]), delete: jest.fn().mockResolvedValue({}) },
        });
        expect(await sweepSandboxTrash(prisma)).toEqual({ purged: 1 });
        expect(upsert).not.toHaveBeenCalled();
    });
});
