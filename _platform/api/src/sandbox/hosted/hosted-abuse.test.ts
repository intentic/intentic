import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { ABUSE_SUSPENSION_REASON, sweepHostedAbuse } from "./hosted-abuse.js";

// The watch reads the provider's per-machine meter and acts on the free lane: a saturated machine is stopped and
// struck, the strike after the line suspends, a subscriber's is only reported, a machine already struck this window
// is left alone, and a builder in the same app never counts against the sandbox.

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const NOW = new Date(`2026-09-14T12:00:00.000Z`);
const MINUTE_MS = 60_000;

const config = (over: Record<string, unknown> = {}): Config =>
    ({
        webOrigin: `https://app.test`,
        // Unconfigured mail logs instead of sending, so the real send path runs with no Resend stub.
        email: { apiKey: ``, from: `` },
        ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
        hosted: {
            flyApiToken: `fly`,
            flyOrg: `intentic`,
            appPrefix: `intentic-sbx`,
            cpus: 4,
            metricsUrl: `https://api.fly.io/prometheus`,
            abuseMinutes: 15,
            abuseWindowMinutes: 90,
            abuseCpuShare: 0.85,
            abuseEgressGbPerHour: 10,
            abuseStrikesToSuspend: 2,
            abuseStrikeDays: 30,
            ...over,
        },
        hostedPlan: { compEmails: `` },
    }) as unknown as Config;

// One machine as the sweep selects it: awake for two hours already.
const machine = (over: Record<string, unknown> = {}) => ({
    id: `h1`,
    appName: `intentic-sbx-a`,
    machineId: `m1`,
    wokeAt: new Date(NOW.getTime() - 120 * MINUTE_MS),
    sandbox: { id: `s1`, name: `dev`, ownerId: `u1`, owner: { email: `owner@example.test` } },
    ...over,
});

interface Strike {
    readonly userId: string;
    readonly appName: string;
    readonly action: string;
    readonly createdAt: Date;
}

const prismaWith = (
    rows: ReturnType<typeof machine>[],
    strikes: Strike[] = [],
    over: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {},
) => {
    const created: Record<string, unknown>[] = [];
    const prisma = {
        hostedMachine: { findMany: vi.fn().mockResolvedValue(rows), update: vi.fn().mockResolvedValue({}) },
        hostedStrike: {
            findFirst: vi.fn(
                async ({ where }: { where: { appName: string; createdAt: { gte: Date } } }) =>
                    strikes.find((strike) => strike.appName === where.appName && strike.createdAt >= where.createdAt.gte) ?? null,
            ),
            count: vi.fn(
                async ({ where }: { where: { userId: string; action: { in: string[] }; createdAt: { gte: Date } } }) =>
                    strikes.filter(
                        (strike) =>
                            strike.userId === where.userId && where.action.in.includes(strike.action) && strike.createdAt >= where.createdAt.gte,
                    ).length,
            ),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                created.push(data);
                return data;
            }),
        },
        hostedUsage: { upsert: vi.fn().mockResolvedValue({}) },
        hostedPlan: { findUnique: vi.fn().mockResolvedValue(null) },
        user: { update: vi.fn().mockResolvedValue({}) },
        ...over,
    } as unknown as PrismaClient;
    return { prisma, created };
};

interface Sample {
    readonly app: string;
    readonly instance: string;
    readonly value: number;
}

// Prometheus's instant-vector envelope for one rule's samples.
const vector = (rows: readonly Sample[]): Response =>
    new Response(
        JSON.stringify({
            status: `success`,
            data: {
                resultType: `vector`,
                result: rows.map((row) => ({ metric: { app: row.app, instance: row.instance }, value: [1, String(row.value)] })),
            },
        }),
    );

// Fly's two APIs behind one fetch: the metrics query answers per rule; the Machines API records stops and reports a
// machine stopped once it was told to, as Fly does.
const stubFly = (samples: { cpu?: Sample[]; egress?: Sample[] }) => {
    const calls: { method: string; url: string }[] = [];
    const stopped = new Set<string>();
    const machines = (href: string): Response => {
        if (href.endsWith(`/stop`)) {
            stopped.add(href.slice(0, -`/stop`.length));
            return new Response(``, { status: 200 });
        }
        return new Response(JSON.stringify({ id: `m1`, state: stopped.has(href) ? `stopped` : `started` }));
    };
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
        const href = String(url);
        calls.push({ method: init?.method ?? `GET`, url: href });
        if (href.startsWith(`https://api.fly.io/prometheus/`)) {
            const query = decodeURIComponent(new URL(href).searchParams.get(`query`) ?? ``);
            return Promise.resolve(vector(query.includes(`fly_instance_cpu`) ? (samples.cpu ?? []) : (samples.egress ?? [])));
        }
        return Promise.resolve(href.startsWith(`https://api.machines.dev/`) ? machines(href) : new Response(``, { status: 404 }));
    });
    return calls;
};

const stops = (calls: { method: string; url: string }[]) => calls.filter((call) => call.method === `POST` && call.url.endsWith(`/stop`));
const queries = (calls: { method: string; url: string }[]) => calls.filter((call) => call.url.startsWith(`https://api.fly.io/prometheus/`));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`the abuse watch`, () => {
    it(`stops a free machine at full CPU for the window, strikes it and closes its stretch`, async () => {
        const calls = stubFly({ cpu: [{ app: `intentic-sbx-a`, instance: `m1`, value: 0.97 }] });
        const { prisma, created } = prismaWith([machine()]);
        expect(await sweepHostedAbuse(prisma, config(), logger, NOW)).toEqual({ stopped: 1, suspended: 0, reported: 0 });
        expect(stops(calls).map((call) => call.url)).toEqual([expect.stringContaining(`/apps/intentic-sbx-a/machines/m1/stop`)]);
        expect(created).toEqual([
            expect.objectContaining({ userId: `u1`, appName: `intentic-sbx-a`, kind: `cpu`, measure: 0.97, windowMinutes: 90, action: `stopped` }),
        ]);
        // The stretch is charged and closed at the stop, not left for the meter to find.
        expect(prisma.hostedUsage.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { userId: `u1`, month: `2026-09`, minutes: 120 } }));
        expect(prisma.hostedMachine.update).toHaveBeenCalledWith({ where: { id: `h1` }, data: { wokeAt: null } });
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it(`asks the provider with the window, the prefix and the machine's CPU count`, async () => {
        const calls = stubFly({});
        await sweepHostedAbuse(prismaWith([machine()]).prisma, config(), logger, NOW);
        const asked = queries(calls).map((call) => decodeURIComponent(new URL(call.url).searchParams.get(`query`) ?? ``));
        expect(asked).toHaveLength(2);
        expect(asked[0]).toBe(`sum by (app, instance) (rate(fly_instance_cpu{app=~"intentic-sbx-.*", mode!="idle"}[90m])) / 400`);
        expect(asked[1]).toContain(`fly_instance_net_sent_bytes`);
        expect(queries(calls)[0]?.url.startsWith(`https://api.fly.io/prometheus/intentic/api/v1/query?`)).toBe(true);
    });

    it(`leaves a machine under the line, and a builder's sample in the same app, alone`, async () => {
        const calls = stubFly({
            cpu: [
                { app: `intentic-sbx-a`, instance: `m1`, value: 0.6 },
                { app: `intentic-sbx-a`, instance: `builder`, value: 1 },
            ],
        });
        const { prisma, created } = prismaWith([machine()]);
        expect(await sweepHostedAbuse(prisma, config(), logger, NOW)).toEqual({ stopped: 0, suspended: 0, reported: 0 });
        expect(stops(calls)).toHaveLength(0);
        expect(created).toEqual([]);
    });

    it(`suspends the account on the second strike within the strike window, and says so to the owner`, async () => {
        const calls = stubFly({ cpu: [{ app: `intentic-sbx-a`, instance: `m1`, value: 0.99 }] });
        const earlier = { userId: `u1`, appName: `intentic-sbx-a`, action: `stopped`, createdAt: new Date(NOW.getTime() - 10 * 24 * 60 * MINUTE_MS) };
        const { prisma, created } = prismaWith([machine()], [earlier]);
        expect(await sweepHostedAbuse(prisma, config(), logger, NOW)).toEqual({ stopped: 0, suspended: 1, reported: 0 });
        expect(stops(calls)).toHaveLength(1);
        expect(created).toEqual([expect.objectContaining({ action: `suspended` })]);
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: `u1` },
            data: { hostedSuspendedAt: NOW, hostedSuspendedReason: ABUSE_SUSPENSION_REASON },
        });
    });

    it(`does not count a strike older than the strike window, nor suspend with the line at 0`, async () => {
        stubFly({ cpu: [{ app: `intentic-sbx-a`, instance: `m1`, value: 0.99 }] });
        const old = { userId: `u1`, appName: `intentic-sbx-b`, action: `stopped`, createdAt: new Date(NOW.getTime() - 40 * 24 * 60 * MINUTE_MS) };
        const aged = prismaWith([machine()], [old]);
        expect(await sweepHostedAbuse(aged.prisma, config(), logger, NOW)).toMatchObject({ stopped: 1, suspended: 0 });

        stubFly({ cpu: [{ app: `intentic-sbx-a`, instance: `m1`, value: 0.99 }] });
        const recent = { ...old, createdAt: new Date(NOW.getTime() - 24 * 60 * MINUTE_MS) };
        const lenient = prismaWith([machine()], [recent]);
        expect(await sweepHostedAbuse(lenient.prisma, config({ abuseStrikesToSuspend: 0 }), logger, NOW)).toMatchObject({ stopped: 1, suspended: 0 });
    });

    it(`reports a subscriber's saturated machine without stopping it`, async () => {
        const calls = stubFly({ cpu: [{ app: `intentic-sbx-a`, instance: `m1`, value: 1 }] });
        const { prisma, created } = prismaWith([machine()], [], { hostedPlan: { findUnique: vi.fn().mockResolvedValue({ status: `active` }) } });
        expect(await sweepHostedAbuse(prisma, config(), logger, NOW)).toEqual({ stopped: 0, suspended: 0, reported: 1 });
        expect(stops(calls)).toHaveLength(0);
        expect(created).toEqual([expect.objectContaining({ action: `reported` })]);
    });

    it(`strikes one machine once per window, however many ticks see it`, async () => {
        const calls = stubFly({ cpu: [{ app: `intentic-sbx-a`, instance: `m1`, value: 1 }] });
        const struck = { userId: `u1`, appName: `intentic-sbx-a`, action: `stopped`, createdAt: new Date(NOW.getTime() - 20 * MINUTE_MS) };
        const { prisma, created } = prismaWith([machine()], [struck]);
        expect(await sweepHostedAbuse(prisma, config(), logger, NOW)).toEqual({ stopped: 0, suspended: 0, reported: 0 });
        expect(stops(calls)).toHaveLength(0);
        expect(created).toEqual([]);
    });

    it(`strikes on egress too, and skips that rule with its threshold at 0`, async () => {
        stubFly({ egress: [{ app: `intentic-sbx-a`, instance: `m1`, value: 25 }] });
        const { created } = { created: [] as Record<string, unknown>[] };
        const first = prismaWith([machine()]);
        expect(await sweepHostedAbuse(first.prisma, config(), logger, NOW)).toMatchObject({ stopped: 1 });
        expect(first.created).toEqual([expect.objectContaining({ kind: `egress`, measure: 25 })]);
        expect(created).toEqual([]);

        const calls = stubFly({ egress: [{ app: `intentic-sbx-a`, instance: `m1`, value: 25 }] });
        const second = prismaWith([machine()]);
        expect(await sweepHostedAbuse(second.prisma, config({ abuseEgressGbPerHour: 0 }), logger, NOW)).toMatchObject({ stopped: 0 });
        expect(queries(calls)).toHaveLength(1);
    });

    it(`selects only machines awake for a whole window, and asks nothing when there are none`, async () => {
        const calls = stubFly({ cpu: [{ app: `intentic-sbx-a`, instance: `m1`, value: 1 }] });
        const { prisma } = prismaWith([]);
        expect(await sweepHostedAbuse(prisma, config(), logger, NOW)).toEqual({ stopped: 0, suspended: 0, reported: 0 });
        expect(prisma.hostedMachine.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { wokeAt: { lte: new Date(NOW.getTime() - 90 * MINUTE_MS) } } }),
        );
        expect(queries(calls)).toHaveLength(0);
    });

    it(`is off with the tick at 0 or no lane`, async () => {
        const calls = stubFly({ cpu: [{ app: `intentic-sbx-a`, instance: `m1`, value: 1 }] });
        const { prisma } = prismaWith([machine()]);
        expect(await sweepHostedAbuse(prisma, config({ abuseMinutes: 0 }), logger, NOW)).toEqual({ stopped: 0, suspended: 0, reported: 0 });
        expect(await sweepHostedAbuse(prisma, config({ flyApiToken: `` }), logger, NOW)).toEqual({ stopped: 0, suspended: 0, reported: 0 });
        expect(calls).toHaveLength(0);
    });
});
