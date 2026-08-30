import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../../config.js";
import { runHostedCanary } from "./hosted-canary.js";
import { forgetNamespace } from "../zrok-provision.js";

/* WHAT THE CANARY IS FOR, in one sentence: the health sweep can see a machine go missing, and cannot see a
 * lane that is intact but no longer works. Production sat for days with six sandboxes provisioned and not one
 * daemon check-in among them, and nothing on the platform said a word, because from the inside that is
 * indistinguishable from six people who opened the page and wandered off. */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const nap = () => Promise.resolve();

const config = (over: Record<string, unknown> = {}): Config =>
    ({
        webOrigin: `https://app.test`,
        api: { url: `https://api.test` },
        admin: { emails: `` },
        email: { apiKey: ``, from: `` },
        google: { clientId: `gcid` },
        secrets: { key: `` },
        zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
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
            poolSize: 0,
            canaryMinutes: 60,
            canaryEmail: `canary@intentic.test`,
            ...over,
        },
    }) as unknown as Config;

// The canary's own sandbox row, and the announce it is waiting for: `lastSeenAt` is written by the daemon
// checking in, so a fixture that sets it IS a machine that came up.
const prismaWith = (lastSeenAt: Date | null, over: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {}) => {
    const sandbox = { id: `canary-sbx`, name: `hosted canary`, token: `tok`, zrokToken: null, ownerId: `canary-user` };
    return {
        user: { findUnique: vi.fn().mockResolvedValue({ id: `canary-user` }), create: vi.fn().mockResolvedValue({ id: `canary-user` }) },
        sandbox: {
            findMany: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockResolvedValue(sandbox),
            findUnique: vi.fn().mockResolvedValue({ ...sandbox, lastSeenAt }),
            update: vi.fn().mockResolvedValue(sandbox),
            delete: vi.fn().mockResolvedValue(sandbox),
        },
        hostedMachine: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue({ appName: `intentic-sbx-canary` }) },
        hostedPoolMachine: { findMany: vi.fn().mockResolvedValue([]) },
        ...over,
    } as unknown as PrismaClient;
};

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

// The whole provider surface one canary run touches: the hub's namespace and account, then Fly's cold build,
// then the teardown.
const stubProviders = (over: { machine?: () => Response } = {}) => {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
        const method = init?.method ?? `GET`;
        const target = String(url);
        calls.push({ method, url: target });
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
    vi.unstubAllGlobals();
    forgetNamespace();
});

describe(`the provisioning canary`, () => {
    it(`passes when the machine it built checks in, and takes everything it made back down`, async () => {
        const calls = stubProviders();
        const prisma = prismaWith(new Date());
        const result = await runHostedCanary(prisma, config(), logger, nap);
        expect(result.ok).toBe(true);
        // The teardown is not optional: a canary that leaks machines costs more than the outage it watches for.
        expect(prisma.sandbox.delete).toHaveBeenCalledWith({ where: { id: `canary-sbx` } });
        expect(calls.some((entry) => entry.method === `DELETE`)).toBe(true);
    });

    /* THE FAILURE THIS EXISTS TO CATCH: provisioning succeeds, Fly is happy, the row is written, and the
     * daemon never speaks. Nothing else on the platform can tell that apart from an ordinary abandoned signup. */
    it(`fails when the machine is built but never checks in`, async () => {
        stubProviders();
        const prisma = prismaWith(null);
        const result = await runHostedCanary(prisma, config(), logger, nap);
        expect(result.ok).toBe(false);
        expect(result.detail).toContain(`never checked in`);
        expect(prisma.sandbox.delete).toHaveBeenCalledWith({ where: { id: `canary-sbx` } });
    });

    it(`fails, and still cleans up, when the provider refuses to build at all`, async () => {
        stubProviders({ machine: () => json({ error: `no capacity in iad` }, 422) });
        const prisma = prismaWith(new Date());
        const result = await runHostedCanary(prisma, config(), logger, nap);
        expect(result.ok).toBe(false);
        expect(result.detail).toContain(`no capacity`);
        expect(prisma.sandbox.delete).toHaveBeenCalledWith({ where: { id: `canary-sbx` } });
    });

    it(`does nothing at all when it is switched off, or the lane is`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal(`fetch`, fetchSpy);
        expect((await runHostedCanary(prismaWith(null), config({ canaryEmail: `` }), logger, nap)).detail).toBe(`canary off`);
        expect((await runHostedCanary(prismaWith(null), config({ flyApiToken: `` }), logger, nap)).detail).toBe(`canary off`);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
