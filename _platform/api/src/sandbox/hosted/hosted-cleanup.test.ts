import { Prisma, type PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../../config.js";
import { testIngressConfig } from "../../testing.js";
import { connectTokenIdentity } from "../mint-sandbox.js";
import { assertHostedIdentity, HostedProvisionCancelled, reconcileHostedCleanup, releaseHosted } from "./hosted-cleanup.js";
import { provisionHosted } from "./hosted.js";

vi.mock(`./hosted-app-lock.js`, async () => ({ withHostedAppLock: (await import(`../../testing.js`)).fakeHostedAppLock }));
vi.mock(`./build/hosted-image.js`, async (original) => ({
    ...(await original<typeof import("./build/hosted-image.js")>()),
    resolveHostedImage: async () => `registry.test/sandbox@sha256:abc`,
}));

const config = configSchema.parse({
    database: { url: `postgres://test` },
    betterAuth: { secret: `test` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    ingress: testIngressConfig,
    hosted: { flyApiToken: `fly`, flyOrg: `org` },
});
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const args = { sandboxId: `s1`, connectToken: `token`, ownerEmail: `owner@example.test`, region: `iad` };
const appName = `${config.hosted.appPrefix}-${connectTokenIdentity(args.connectToken).tunnelId}`;

const fixture = () => {
    const pending = new Set<string>();
    const state = {
        sandbox: {
            id: args.sandboxId,
            ownerId: `u1`,
            token: args.connectToken,
            ...connectTokenIdentity(args.connectToken),
            daemonUrl: `https://old.test`,
            lastSeenAt: new Date(),
            setupCode: `code`,
            hosted: null as { id: string; appName: string; wokeAt: Date | null } | null,
        },
    };
    const db = {
        $transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => work(db)),
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn().mockResolvedValue(0),
        sandbox: {
            findUnique: vi.fn(async () => state.sandbox),
            findUniqueOrThrow: vi.fn(async () => state.sandbox),
            update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(state.sandbox, data)),
        },
        hostedMachine: {
            findUnique: vi.fn(async () => state.sandbox.hosted),
            count: vi.fn(async () => (state.sandbox.hosted === null ? 0 : 1)),
            create: vi.fn(async ({ data }: { data: { appName: string; wokeAt: Date | null } }) => {
                state.sandbox.hosted = { id: `h1`, ...data };
            }),
            delete: vi.fn(async () => {
                state.sandbox.hosted = null;
            }),
        },
        hostedPlan: { findUnique: vi.fn().mockResolvedValue(null) },
        hostedPoolMachine: {
            findMany: vi.fn().mockResolvedValue([]),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            delete: vi.fn().mockResolvedValue({}),
        },
        hostedCleanup: {
            create: vi.fn(async ({ data }: { data: { appName: string } }) => {
                pending.add(data.appName);
            }),
            upsert: vi.fn(async ({ create }: { create: { appName: string } }) => {
                pending.add(create.appName);
            }),
            deleteMany: vi.fn(async ({ where }: { where: { appName: string } }) => {
                pending.delete(where.appName);
            }),
            findMany: vi.fn(async () => [...pending].map((name) => ({ appName: name }))),
            findUnique: vi.fn(async ({ where }: { where: { appName: string } }) => (pending.has(where.appName) ? { appName: where.appName } : null)),
        },
    };
    return { db, prisma: db as unknown as PrismaClient, state, pending };
};

const provider = (pending: Set<string>, pauseAt?: string) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const state = { exists: false, failDelete: false, deleting: false };
    const calls: string[] = [];
    vi.stubGlobal(`fetch`, async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        const method = init.method;
        calls.push(`${method} ${path}${new URL(url).search}`);
        if (path === pauseAt || `${method} ${path}` === pauseAt) {
            entered.resolve();
            await resume.promise;
        }
        if (method === `POST`) {
            expect(pending.size).toBe(1);
            if (path === `/v1/apps`) {
                state.exists = true;
            }
            return Response.json({ id: path.endsWith(`/volumes`) ? `v1` : `m1`, state: `started` });
        }
        if (method === `DELETE`) {
            if (state.failDelete) {
                return Response.json({ error: `unavailable` }, { status: 503 });
            }
            if (!state.deleting) {
                state.exists = false;
            }
            return new Response(null, { status: 202 });
        }
        return state.exists ? Response.json({ id: `app`, state: `replacing` }) : Response.json({ error: `gone` }, { status: 404 });
    });
    return { state, calls, entered, resume };
};

afterEach(() => vi.unstubAllGlobals());

describe(`hosted cancellation`, () => {
    it.each([`/v1/apps`, `/v1/apps/${appName}/volumes`, `/v1/apps/${appName}/machines`])(
        `cancels during %s, waits for the writer, and removes every allocated resource`,
        async (pauseAt) => {
            const { db, prisma, state, pending } = fixture();
            const fly = provider(pending, pauseAt);
            const creating = provisionHosted(prisma, config, logger, args);
            const cancelled = expect(creating).rejects.toBeInstanceOf(HostedProvisionCancelled);
            await fly.entered.promise;
            await releaseHosted(prisma, config, args.sandboxId);
            await reconcileHostedCleanup(prisma, config, logger);
            expect(fly.calls.filter((call) => call.startsWith(`DELETE`))).toEqual([]);
            expect([...pending]).toEqual([appName]);
            fly.resume.resolve();
            await cancelled;
            expect(db.hostedMachine.create).not.toHaveBeenCalled();
            expect(state.sandbox.hosted).toBeNull();
            expect(state.sandbox.lastSeenAt).toBeNull();
            expect(state.sandbox.daemonUrl).toBeNull();
            expect(state.sandbox.setupCode).toBeNull();
            expect(fly.state.exists).toBe(false);
            expect([...pending]).toEqual([]);
            expect(fly.calls).toContain(`DELETE /v1/apps/${appName}?force=true`);
        },
    );

    it(`revokes a connected machine immediately and retains cleanup across a provider failure`, async () => {
        const { prisma, state, pending } = fixture();
        state.sandbox.hosted = { id: `h1`, appName, wokeAt: null };
        const fly = provider(pending);
        fly.state.exists = true;
        fly.state.failDelete = true;
        await releaseHosted(prisma, config, args.sandboxId);
        expect(fly.calls).toEqual([]);
        expect(state.sandbox.hosted).toBeNull();
        await expect(assertHostedIdentity(prisma, args.sandboxId, args.connectToken)).rejects.toBeInstanceOf(HostedProvisionCancelled);
        await expect(assertHostedIdentity(prisma, args.sandboxId, state.sandbox.token)).resolves.toBeUndefined();
        await reconcileHostedCleanup(prisma, config, logger);
        expect([...pending]).toEqual([appName]);
        expect(fly.state.exists).toBe(true);
        fly.state.failDelete = false;
        await reconcileHostedCleanup(prisma, config, logger);
        expect([...pending]).toEqual([]);
        expect(fly.state.exists).toBe(false);
    });

    it(`keeps an accepted deletion queued until the app is confirmed absent`, async () => {
        const { prisma, pending } = fixture();
        pending.add(appName);
        const fly = provider(pending);
        fly.state.exists = true;
        fly.state.deleting = true;
        await reconcileHostedCleanup(prisma, config, logger);
        expect([...pending]).toEqual([appName]);
        fly.state.deleting = false;
        await reconcileHostedCleanup(prisma, config, logger);
        expect([...pending]).toEqual([]);
    });

    it(`collects an allocation left by a crashed provision without a sandbox row`, async () => {
        const { prisma, db, pending } = fixture();
        pending.add(appName);
        db.sandbox.findUnique.mockRejectedValue(new Error(`sandbox was deleted`));
        const fly = provider(pending);
        fly.state.exists = true;
        await reconcileHostedCleanup(prisma, config, logger);
        expect(fly.state.exists).toBe(false);
        expect([...pending]).toEqual([]);
        expect(db.sandbox.findUnique).not.toHaveBeenCalled();
    });

    it(`does not collect an allocation that successfully commits while cleanup is running`, async () => {
        const { prisma, state, pending } = fixture();
        const fly = provider(pending, `/v1/apps/${appName}/machines`);
        const creating = provisionHosted(prisma, config, logger, args);
        await fly.entered.promise;
        await reconcileHostedCleanup(prisma, config, logger);
        fly.resume.resolve();
        expect(await creating).toEqual({ appName, region: `iad`, warm: false });
        await reconcileHostedCleanup(prisma, config, logger);
        expect(state.sandbox.hosted?.appName).toBe(appName);
        expect(fly.state.exists).toBe(true);
        expect([...pending]).toEqual([]);
        expect(fly.calls.filter((call) => call.startsWith(`DELETE`))).toEqual([]);
    });

    it(`refuses a delayed provision request whose identity was already cancelled`, async () => {
        const { prisma, pending, db } = fixture();
        const fly = provider(pending);
        await releaseHosted(prisma, config, args.sandboxId);
        await expect(provisionHosted(prisma, config, logger, args)).rejects.toBeInstanceOf(HostedProvisionCancelled);
        expect(db.hostedCleanup.create).not.toHaveBeenCalled();
        expect(fly.calls).toEqual([]);
    });

    it(`does not destroy an existing app when its create request is refused`, async () => {
        const { prisma, pending } = fixture();
        const fetch = vi.fn().mockResolvedValue(Response.json({ error: `app name already exists` }, { status: 422 }));
        vi.stubGlobal(`fetch`, fetch);
        await expect(provisionHosted(prisma, config, logger, args)).rejects.toThrow(`app name already exists`);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(`https://api.machines.dev/v1/apps`, expect.objectContaining({ method: `POST` }));
        expect([...pending]).toEqual([]);
    });

    it(`preserves a committed machine when the transaction response is lost`, async () => {
        const { prisma, db, state, pending } = fixture();
        const fly = provider(pending);
        db.$transaction.mockImplementation(async (work) => {
            await work(db);
            throw new Error(`transaction response lost`);
        });
        await expect(provisionHosted(prisma, config, logger, args)).rejects.toThrow(`transaction response lost`);
        expect(state.sandbox.hosted?.appName).toBe(appName);
        expect([...pending]).toEqual([]);
        expect(fly.state.exists).toBe(true);
        expect(fly.calls.filter((call) => call.startsWith(`DELETE`))).toEqual([]);
    });

    it.each([`POST`, `GET`])(`cancels a warm claim during %s without starting or adopting the pool identity`, async (method) => {
        const { prisma, pending, db, state } = fixture();
        const warmApp = `intentic-sbx-warm`;
        db.hostedPoolMachine.findMany.mockResolvedValue([
            {
                id: `p1`,
                appName: warmApp,
                machineId: `m1`,
                volumeId: `v1`,
                token: `warm-token`,
                image: `registry.test/sandbox@sha256:abc`,
                region: `iad`,
            },
        ]);
        const fly = provider(pending, `${method} /v1/apps/${warmApp}/machines/m1`);
        fly.state.exists = true;
        const creating = provisionHosted(prisma, config, logger, args);
        const cancelled = expect(creating).rejects.toBeInstanceOf(HostedProvisionCancelled);
        await fly.entered.promise;
        await releaseHosted(prisma, config, args.sandboxId);
        const localToken = state.sandbox.token;
        fly.resume.resolve();
        await cancelled;
        expect(state.sandbox.token).toBe(localToken);
        expect(db.hostedMachine.create).not.toHaveBeenCalled();
        expect(db.hostedPoolMachine.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { appName: warmApp, state: `claimed` } });
        expect(fly.calls.some((call) => call.endsWith(`/start`))).toBe(false);
        expect(fly.state.exists).toBe(false);
        expect([...pending]).toEqual([]);
    });

    it(`clears all reports and old setup credentials when releasing`, async () => {
        const { prisma, db } = fixture();
        await releaseHosted(prisma, config, args.sandboxId);
        expect(db.sandbox.update).toHaveBeenCalledWith({
            where: { id: args.sandboxId },
            data: {
                token: expect.any(String),
                tokenDigest: expect.any(String),
                tunnelId: expect.any(String),
                daemonUrl: null,
                lastSeenAt: null,
                setupCode: null,
                setupCodeExpiresAt: null,
                setupCodeClaimedAt: null,
                setupPayload: Prisma.DbNull,
                setupReport: Prisma.DbNull,
                bootReport: Prisma.DbNull,
                announceRefusal: Prisma.DbNull,
            },
        });
    });
});
