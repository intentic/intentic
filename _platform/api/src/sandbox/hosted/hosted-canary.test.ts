import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { runHostedCanary } from "./hosted-canary.js";
import { forgetProviderCapacity, noteProviderAtCapacity } from "./hosted-capacity.js";
import { fakeHostedAppLock, testIngressConfig } from "../../testing.js";

jest.mock(`./hosted-app-lock.js`, () => ({ withHostedAppLock: fakeHostedAppLock }));

// Catches a lane that's intact but broken: the health sweep only notices a machine going missing, not one that never
// checks in at all.

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;
const nap = () => Promise.resolve();

const config = (over: Record<string, unknown> = {}): Config =>
    ({
        webOrigin: `https://app.test`,
        api: { url: `https://api.test` },
        admin: { emails: `` },
        email: { apiKey: ``, from: `` },
        google: { clientId: `gcid` },
        secrets: { key: `` },
        ingress: { ...testIngressConfig },
        hosted: {
            flyApiToken: `fly`,
            flyOrg: `intentic`,
            appPrefix: `intentic-sbx`,
            image: `ghcr.io/intentic/sandbox:stable`,
            region: `iad`,
            regionEu: `arn`,
            cpus: 2,
            memoryMb: 4096,
            volumeGb: 10,
            idleStopMinutes: 20,
            perUser: 1,
            poolSize: 0,
            canaryMinutes: 60,
            canaryEmail: `canary@intentic.test`,
            ...over,
        },
    }) as unknown as Config;

// lastSeenAt is written by the daemon's check-in; setting it in a fixture means a machine that came up.
const prismaWith = (lastSeenAt: Date | null, over: Record<string, Record<string, ReturnType<typeof jest.fn>>> = {}) => {
    const sandbox = { id: `canary-sbx`, name: `hosted canary`, token: `tok`, tunnelId: `abcdef012345`, ownerId: `canary-user` };
    const prisma = {
        user: { findUnique: jest.fn().mockResolvedValue({ id: `canary-user` }), create: jest.fn().mockResolvedValue({ id: `canary-user` }) },
        sandbox: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(sandbox, data)),
            findUnique: jest.fn(async () => ({ ...sandbox, lastSeenAt })),
            findUniqueOrThrow: jest.fn().mockResolvedValue(sandbox),
            update: jest.fn().mockResolvedValue(sandbox),
            delete: jest.fn().mockResolvedValue(sandbox),
        },
        // The row write runs under the owner's slot lock (hosted.ts withHostedSlot): the callback runs against
        // this same fake, the lock is a no-op, and `hostedMachine.count` below is the canary owner's use, none.
        $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => work(prisma)),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
        hostedCleanup: {
            create: jest.fn().mockResolvedValue({}),
            findUnique: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        // The slot count reads the owner's plan (hosted-plan.ts hostedSlotsOf): the canary's account has none.
        hostedPlan: { findUnique: jest.fn().mockResolvedValue(null) },
        // The counts are how the run asks whether the lane has any machines left before it spends one
        // (hosted-capacity.ts). An empty fleet with no stock: this platform's whole capacity is whatever the
        // case's own config and refusals say it is.
        hostedMachine: {
            create: jest.fn().mockResolvedValue({}),
            findUnique: jest.fn(async ({ where }: { where: { appName?: string } }) => (where.appName ? null : { appName: `intentic-sbx-canary` })),
            count: jest.fn().mockResolvedValue(0),
        },
        hostedPoolMachine: {
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        hostedBuild: { count: jest.fn().mockResolvedValue(0) },
        ...over,
    };
    return prisma as unknown as PrismaClient;
};

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

// Every provider surface one canary run touches: the hub's namespace/account, Fly's cold build, then teardown.
const stubProviders = (over: { machine?: () => Response; starter?: () => Response } = {}) => {
    const calls: { method: string; url: string }[] = [];
    stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
        const method = init?.method ?? `GET`;
        const target = String(url);
        calls.push({ method, url: target });
        // The starter's preview address, probed the way the daemon does; serves unless a test overrides it.
        if (target.includes(`/__intentic/preview-probe`)) {
            return Promise.resolve((over.starter ?? (() => json({ proxy: `intentic-preview`, target: `panel`, state: `serving` })))());
        }
        if (target.endsWith(`/api/v2/namespaces`)) {
            return Promise.resolve(json([{ namespaceToken: `ns-1`, name: `public`, open: true }]));
        }
        if (target.includes(`/api/v2/`)) {
            return Promise.resolve(json({ accountToken: `acct-1` }));
        }
        if (method === `DELETE`) {
            return Promise.resolve(new Response(``, { status: 202 }));
        }
        if (target.endsWith(`/apps`)) {
            return Promise.resolve(json({ id: `a1` }));
        }
        if (target.includes(`/volumes`)) {
            return Promise.resolve(json({ id: `vol_1` }));
        }
        if (target.includes(`/machines`)) {
            return Promise.resolve((over.machine ?? (() => json({ id: `m1`, state: `created` })))());
        }
        return Promise.resolve(json({}));
    });
    return calls;
};

afterEach(() => {
    unstubAllGlobals();
    // Resets capacity memory (module-level, not fixture-level) so one test's refusal doesn't leak into the next.
    forgetProviderCapacity();
});

describe(`the provisioning canary`, () => {
    it(`passes when the machine it built checks in, and takes everything it made back down`, async () => {
        const calls = stubProviders();
        const prisma = prismaWith(new Date());
        const result = await runHostedCanary(prisma, config(), logger, nap);
        expect(result.ok).toBe(true);
        // Green requires both: the daemon checked in and the starter answered at its preview address.
        expect(result.starterServingInMs).toEqual(expect.any(Number));
        expect(calls.some((entry) => entry.url.startsWith(`https://preview-site--landing-`) && entry.url.includes(`/__intentic/preview-probe`))).toBe(
            true,
        );
        expect(prisma.sandbox.delete).toHaveBeenCalledWith({ where: { id: `canary-sbx` } });
        expect(calls.some((entry) => entry.method === `DELETE`)).toBe(true);
    });

    /* A WARM CLAIM ADOPTS THE POOL MACHINE'S IDENTITY (hosted.ts claimPoolMachine): the row's token, digest and tunnel id all move. */
    it(`probes the address the row ends up with, not the one it was minted with`, async () => {
        const adopted = `99887766aabb`;
        const prisma = prismaWith(new Date());
        (prisma.sandbox as unknown as { findUniqueOrThrow: ReturnType<typeof jest.fn> }).findUniqueOrThrow.mockResolvedValue({
            id: `canary-sbx`,
            ownerId: `canary-user`,
            tunnelId: adopted,
        });
        const calls = stubProviders();
        const result = await runHostedCanary(prisma, config(), logger, nap);
        expect(result.ok).toBe(true);
        expect(calls.some((entry) => entry.url.includes(adopted) && entry.url.includes(`/__intentic/preview-probe`))).toBe(true);
    });

    it(`fails when the daemon checks in but the starter never serves`, async () => {
        stubProviders({ starter: () => json({ proxy: `intentic-preview`, target: `panel`, state: `starting` }) });
        const prisma = prismaWith(new Date());
        const result = await runHostedCanary(prisma, config(), logger, nap);
        expect(result.ok).toBe(false);
        expect(result.announcedInMs).toEqual(expect.any(Number));
        expect(result.starterServingInMs).toBeUndefined();
        expect(result.detail).toContain(`starter site never served`);
        expect(prisma.sandbox.delete).toHaveBeenCalledWith({ where: { id: `canary-sbx` } });
    });

    it(`fails when the machine is built but never checks in`, async () => {
        stubProviders();
        const prisma = prismaWith(null);
        const result = await runHostedCanary(prisma, config(), logger, nap);
        expect(result.ok).toBe(false);
        expect(result.detail).toContain(`12 minutes`);
        expect(prisma.sandbox.delete).toHaveBeenCalledWith({ where: { id: `canary-sbx` } });
    });

    it(`fails, and still cleans up, when the provider refuses to build at all`, async () => {
        stubProviders({ machine: () => json({ error: `the machine could not be created` }, 500) });
        const prisma = prismaWith(new Date());
        const result = await runHostedCanary(prisma, config(), logger, nap);
        expect(result.ok).toBe(false);
        expect(result.detail).toContain(`the machine could not be created`);
        expect(prisma.sandbox.delete).toHaveBeenCalledWith({ where: { id: `canary-sbx` } });
    });

    it(`says the lane is out of machines in the operator's words, not the reader's`, async () => {
        stubProviders({ machine: () => json({ error: `You have reached the maximum number of machines for this app` }, 422) });
        const prisma = prismaWith(new Date());
        const result = await runHostedCanary(prisma, config(), logger, nap);
        expect(result.ok).toBe(false);
        expect(result.detail).toBe(`the provider has no machines left for this platform, so a new sandbox cannot be created at all`);
        expect(prisma.sandbox.delete).toHaveBeenCalledWith({ where: { id: `canary-sbx` } });
    });

    it(`stands down entirely while the lane is full`, async () => {
        const fetchSpy = jest.fn();
        stubGlobal(`fetch`, fetchSpy);
        noteProviderAtCapacity(`iad`, `insufficient capacity`);
        const result = await runHostedCanary(prismaWith(new Date()), config(), logger, nap);
        expect(result).toMatchObject({ ok: true, detail: `skipped: the lane is at capacity` });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`does nothing at all when it is switched off, or the lane is`, async () => {
        const fetchSpy = jest.fn();
        stubGlobal(`fetch`, fetchSpy);
        expect((await runHostedCanary(prismaWith(null), config({ canaryEmail: `` }), logger, nap)).detail).toBe(`canary off`);
        expect((await runHostedCanary(prismaWith(null), config({ flyApiToken: `` }), logger, nap)).detail).toBe(`canary off`);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
