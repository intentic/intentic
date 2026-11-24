import { createHash } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import { Hono } from "hono";
import { type Logger, pino } from "pino";
import { z } from "zod";
import { POOL_SIGNAL_KEEP_MS, poolSignalsHttpRoutes } from "./pool-signals.routes.js";

// The platform's half of run-outs shared across sandboxes: it keeps the latest run-out per account hash and pool, and
// answers a sandbox the live ones for the hashes it names, never the ones it reported itself.

const logger: Logger = pino({ level: `silent` });
const NOW = new Date(`2026-11-24T12:00:00Z`);
const digestOf = (token: string) => createHash(`sha256`).update(token).digest(`hex`);
const BOXES = [
    { id: `s1`, token: `tok-one` },
    { id: `s2`, token: `tok-two` },
];
const FP = `a`.repeat(64);
const OTHER = `b`.repeat(64);

interface Row {
    fingerprint: string;
    pool: string;
    ranOutAt: Date;
    resetsAt: Date | null;
    sandboxId: string;
    updatedAt: Date;
}

interface Where {
    fingerprint: { in: string[] };
    sandboxId: { not: string };
    updatedAt: { gte: Date };
}

// SAFETY: only the delegates pool-signals.routes.ts calls, each answering in the shape its `select` asks for.
const fakePrisma = (rows: Row[]): PrismaClient =>
    ({
        sandbox: {
            findUnique: jest.fn(async ({ where }: { where: { tokenDigest: string } }) => {
                const box = BOXES.find((row) => digestOf(row.token) === where.tokenDigest);
                return box === undefined ? null : { id: box.id };
            }),
        },
        providerPoolSignal: {
            findUnique: jest.fn(
                async ({ where }: { where: { fingerprint_pool: { fingerprint: string; pool: string } } }) =>
                    rows.find((row) => row.fingerprint === where.fingerprint_pool.fingerprint && row.pool === where.fingerprint_pool.pool) ?? null,
            ),
            upsert: jest.fn(
                async ({
                    where,
                    create,
                    update,
                }: {
                    where: { fingerprint_pool: { fingerprint: string; pool: string } };
                    create: Omit<Row, `updatedAt`>;
                    update: Partial<Row>;
                }) => {
                    const held = rows.find(
                        (row) => row.fingerprint === where.fingerprint_pool.fingerprint && row.pool === where.fingerprint_pool.pool,
                    );
                    if (held === undefined) {
                        rows.push({ ...create, updatedAt: NOW });
                    } else {
                        Object.assign(held, update, { updatedAt: NOW });
                    }
                },
            ),
            deleteMany: jest.fn(async ({ where }: { where: { updatedAt: { lt: Date } } }) => {
                const kept = rows.filter((row) => row.updatedAt >= where.updatedAt.lt);
                rows.splice(0, rows.length, ...kept);
            }),
            findMany: jest.fn(async ({ where }: { where: Where }) =>
                rows.filter(
                    (row) =>
                        where.fingerprint.in.includes(row.fingerprint) &&
                        row.sandboxId !== where.sandboxId.not &&
                        row.updatedAt >= where.updatedAt.gte &&
                        (row.resetsAt === null || row.resetsAt > NOW),
                ),
            ),
        },
    }) as never;

const AnswerSchema = z.record(z.string(), z.unknown());

const client = (rows: Row[]) => {
    const host = new Hono<{ Variables: { logger: Logger } }>();
    host.use(async (c, next) => {
        c.set(`logger`, logger);
        await next();
    });
    host.route(`/pool-signals`, poolSignalsHttpRoutes({ prisma: fakePrisma(rows), now: () => NOW }));
    return async (path: string, token: string | undefined, body: unknown) => {
        const headers = new Headers({ "content-type": `application/json` });
        if (token !== undefined) {
            headers.set(`x-intentic-connect`, token);
        }
        const response = await host.request(path, { method: `POST`, headers, body: JSON.stringify(body) });
        return { status: response.status, body: AnswerSchema.parse(await response.json()) };
    };
};

const ranOutAt = NOW.getTime() - 60_000;
const resetsAt = Math.floor(NOW.getTime() / 1000) + 3600;

describe(`shared run-outs`, () => {
    it(`answers another sandbox the run-out one reported, and not the reporter itself`, async () => {
        const call = client([]);
        expect((await call(`/pool-signals/report`, `tok-one`, { fingerprint: FP, pool: `five_hour`, ranOutAt, resetsAt })).status).toBe(200);
        const heard = await call(`/pool-signals/read`, `tok-two`, { fingerprints: [FP, OTHER] });
        expect(heard.body).toEqual({ signals: [{ fingerprint: FP, pool: `five_hour`, ranOutAt, resetsAt }] });
        expect((await call(`/pool-signals/read`, `tok-one`, { fingerprints: [FP] })).body).toEqual({ signals: [] });
    });

    it(`keeps the latest run-out of a pool, whichever report arrives last`, async () => {
        const rows: Row[] = [];
        const call = client(rows);
        await call(`/pool-signals/report`, `tok-one`, { fingerprint: FP, pool: `*`, ranOutAt });
        await call(`/pool-signals/report`, `tok-two`, { fingerprint: FP, pool: `*`, ranOutAt: ranOutAt - 30_000 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ sandboxId: `s1`, ranOutAt: new Date(ranOutAt), resetsAt: null });
    });

    it(`serves no run-out past its reset, and prunes one older than eight days as it writes`, async () => {
        const stale = new Date(NOW.getTime() - POOL_SIGNAL_KEEP_MS - 1);
        const rows: Row[] = [
            { fingerprint: FP, pool: `seven_day`, ranOutAt: stale, resetsAt: null, sandboxId: `s1`, updatedAt: stale },
            {
                fingerprint: OTHER,
                pool: `five_hour`,
                ranOutAt: new Date(ranOutAt),
                resetsAt: new Date(NOW.getTime() - 1000),
                sandboxId: `s1`,
                updatedAt: NOW,
            },
        ];
        const call = client(rows);
        expect((await call(`/pool-signals/read`, `tok-two`, { fingerprints: [FP, OTHER] })).body).toEqual({ signals: [] });
        await call(`/pool-signals/report`, `tok-one`, { fingerprint: OTHER, pool: `seven_day`, ranOutAt });
        expect(rows.map((row) => row.fingerprint)).not.toContain(FP);
    });

    it(`refuses an unknown token, a raw account id, a run-out in the future, and too many fingerprints`, async () => {
        const call = client([]);
        expect((await call(`/pool-signals/report`, undefined, { fingerprint: FP, pool: `*`, ranOutAt })).status).toBe(404);
        expect((await call(`/pool-signals/read`, `tok-nobody`, { fingerprints: [FP] })).status).toBe(404);
        expect((await call(`/pool-signals/report`, `tok-one`, { fingerprint: `user@example.com`, pool: `*`, ranOutAt })).status).toBe(400);
        expect((await call(`/pool-signals/report`, `tok-one`, { fingerprint: FP, pool: `*`, ranOutAt: NOW.getTime() + 3_600_000 })).status).toBe(400);
        expect((await call(`/pool-signals/read`, `tok-one`, { fingerprints: Array.from({ length: 33 }, () => FP) })).status).toBe(400);
    });
});
