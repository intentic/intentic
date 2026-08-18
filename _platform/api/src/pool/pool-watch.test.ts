import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { runWatch, watchVerdict } from "./pool-watch.js";

/* Gate 4 — the only gate that never finishes. The verdict is a pure function of counted rows on purpose, so
 * every threshold boundary can be pinned here without a database, and so the rule stated on the site is
 * literally the rule that runs. */

// No SECRETS_KEY, so the canary's decryptSecret passes the fixture's plaintext signing key straight through
// (crypto.ts) — which is exactly the unconfigured-dev path, and keeps these tests about the watch.
const config = {
    secrets: { key: `` },
    pool: {
        graduationRuns: 50,
        maxRefundRate: 0.2,
        watchWindowRuns: 20,
        canaryFailures: 3,
        probeFreshMinutes: 60,
    },
} as unknown as Config;

const runs = (refunded: number, total: number): string[] => [
    ...Array.from({ length: refunded }, () => `refunded`),
    ...Array.from({ length: total - refunded }, () => `ok`),
];

describe(`the watch verdict`, () => {
    it(`keeps a healthy probation listing that has not served enough yet`, () => {
        expect(watchVerdict(config, { status: `probation`, recent: runs(0, 20), servedTotal: 49 })).toBe(`keep`);
    });

    it(`graduates a probation listing once the counter is met`, () => {
        expect(watchVerdict(config, { status: `probation`, recent: runs(0, 20), servedTotal: 50 })).toBe(`graduate`);
    });

    it(`suspends any live listing over the refund rate`, () => {
        // 5 of 20 refunded is 25%, over the published 20%.
        expect(watchVerdict(config, { status: `listed`, recent: runs(5, 20), servedTotal: 500 })).toBe(`suspend`);
        expect(watchVerdict(config, { status: `probation`, recent: runs(5, 20), servedTotal: 10 })).toBe(`suspend`);
    });

    it(`treats the rate as a ceiling to exceed, not to reach`, () => {
        // Exactly 20% is within the published promise; the tripwire fires above it.
        expect(watchVerdict(config, { status: `listed`, recent: runs(4, 20), servedTotal: 500 })).toBe(`keep`);
    });

    /* A partial window cannot trip. Judging a listing on its first three runs would delist a working service
     * that met one bad afternoon — and the refunds already made those three runs free to the member. */
    it(`will not trip on a window that is not full yet`, () => {
        expect(watchVerdict(config, { status: `probation`, recent: runs(3, 3), servedTotal: 0 })).toBe(`keep`);
    });

    it(`suspension outranks graduation when a listing qualifies for both`, () => {
        expect(watchVerdict(config, { status: `probation`, recent: runs(10, 20), servedTotal: 500 })).toBe(`suspend`);
    });

    it(`leaves a draft or suspended listing alone`, () => {
        expect(watchVerdict(config, { status: `draft`, recent: runs(20, 20), servedTotal: 0 })).toBe(`keep`);
        expect(watchVerdict(config, { status: `suspended`, recent: runs(20, 20), servedTotal: 900 })).toBe(`keep`);
    });
});

const NOW = new Date(`2026-08-17T12:00:00.000Z`);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

interface Row {
    id: string;
    slug: string;
    status: string;
    upstreamUrl: string;
    secret: string;
    sampleRequest: string;
    canaryFails: number;
    probedAt: Date | null;
}

// Enough Prisma for the watch: the live-listing scan, three counted reads per row, and the two writes.
const fakePrisma = (rows: Row[], recent: string[], servedTotal: number, servedRecently: number) => {
    const probes: { serviceId: string; passed: boolean; kind: string }[] = [];
    const prisma = {
        service: {
            findMany: vi.fn(async () => rows),
            update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                const row = rows.find((entry) => entry.id === where.id);
                Object.assign(row ?? {}, data);
                return row;
            }),
        },
        serviceRun: {
            findMany: vi.fn(async () => recent.map((status) => ({ status }))),
            count: vi.fn(async ({ where }: { where: { createdAt?: unknown } }) => (where.createdAt === undefined ? servedTotal : servedRecently)),
        },
        serviceProbe: {
            create: vi.fn(async ({ data }: { data: { serviceId: string; passed: boolean; kind: string } }) => {
                probes.push(data);
                return data;
            }),
        },
    } as unknown as PrismaClient;
    return { prisma, rows, probes };
};

const row = (over: Partial<Row> = {}): Row => ({
    id: `svc_1`,
    slug: `acme-research`,
    status: `probation`,
    upstreamUrl: `https://svc.acme.test/run`,
    secret: `plain-secret`,
    sampleRequest: `{"query":"x"}`,
    canaryFails: 0,
    probedAt: null,
    ...over,
});

// The canary's fetch. Every call fails, which is all these tests need — the probe's own pass/fail logic has
// its suite next door.
const deadProvider = (async () => new Response(`down`, { status: 503 })) as unknown as typeof fetch;

// Public DNS, so a failing canary is failing because the PROVIDER is down rather than because a fixture
// hostname does not resolve — which is the thing these tests mean to be about.
const publicLookup = vi.fn(async () => [{ address: `93.184.216.34`, family: 4 }]) as unknown as Parameters<typeof runWatch>[0][`lookupFn`];

describe(`the watch, run over live listings`, () => {
    it(`suspends a listing whose recent runs are mostly refunds, with the reason on the row`, async () => {
        const { prisma, rows } = fakePrisma([row({ status: `listed` })], runs(10, 20), 500, 5);
        await runWatch({ prisma, config, fetchFn: deadProvider, now: () => NOW, lookupFn: publicLookup }, logger);
        expect(rows[0]?.status).toBe(`suspended`);
    });

    it(`graduates a clean probation listing that has served enough`, async () => {
        const { prisma, rows } = fakePrisma([row()], runs(0, 20), 50, 5);
        await runWatch({ prisma, config, fetchFn: deadProvider, now: () => NOW, lookupFn: publicLookup }, logger);
        expect(rows[0]?.status).toBe(`listed`);
    });

    /* Real traffic is a better liveness proof than a synthetic call, and the probe costs the PROVIDER real
     * upstream money every time it runs. A listing that served today is not probed. */
    it(`spends no canary on a listing that served recently`, async () => {
        const { prisma, probes } = fakePrisma([row()], runs(0, 5), 5, 5);
        const fetchFn = vi.fn(deadProvider);
        await runWatch({ prisma, config, fetchFn: fetchFn as unknown as typeof fetch, now: () => NOW, lookupFn: publicLookup }, logger);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(probes).toEqual([]);
    });

    it(`counts a quiet listing's canary failures and suspends on the third`, async () => {
        const { prisma, rows, probes } = fakePrisma([row({ canaryFails: 0 })], [], 0, 0);
        await runWatch({ prisma, config, fetchFn: deadProvider, now: () => NOW, lookupFn: publicLookup }, logger);
        expect(rows[0]?.canaryFails).toBe(1);
        expect(rows[0]?.status).toBe(`probation`);
        expect(probes[0]).toMatchObject({ passed: false, kind: `canary` });

        rows[0] = { ...row({ canaryFails: 2 }) };
        const second = fakePrisma(rows, [], 0, 0);
        await runWatch({ prisma: second.prisma, config, fetchFn: deadProvider, now: () => NOW, lookupFn: publicLookup }, logger);
        expect(second.rows[0]?.status).toBe(`suspended`);
        expect(second.rows[0]?.canaryFails).toBe(3);
    });

    // Operator rows carry no owner and never passed a gate; the scan excludes them at the query, which is the
    // only place that exemption can be enforced once rather than remembered at every branch.
    it(`only ever scans owned listings`, async () => {
        const { prisma } = fakePrisma([], [], 0, 0);
        await runWatch({ prisma, config, fetchFn: deadProvider, now: () => NOW, lookupFn: publicLookup }, logger);
        expect(prisma.service.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: { not: null } }) }));
    });
});
