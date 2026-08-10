import { createHash, createHmac } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import type { StripeGateway } from "./pool-stripe.js";
import { poolHttpRoutes } from "./pool.routes.js";

/* THE POOL IS THE ROUTE FAMILY THE CREATOR PROMISE RESTS ON, so what is pinned here is what a creator or a
 * member would call betrayal if it drifted: the ledger only accepting what a real sandbox reported, premium
 * meaning a paid row and nothing less, the public numbers adding up, and the webhook refusing an unsigned
 * event. */

const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const NOW = new Date(`2026-08-10T12:00:00Z`);

const baseConfig = {
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapAfterDays: 7, reapDryRun: false, poolSize: 0 },
    trial: { keys: ``, baseUrl: `https://upstream.test/v1beta/openai`, models: ``, dailyMessages: 2 },
    pool: { stripeSecretKey: `sk_test`, stripeWebhookSecret: `whsec_test`, stripePriceId: `price_1`, priceUsd: 20, creatorShare: 0.7 },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: false },
} as Config;

const configWith = (pool: Partial<Config[`pool`]>): Config => ({ ...baseConfig, pool: { ...baseConfig.pool, ...pool } });

const digestOf = (token: string) => createHash(`sha256`).update(token).digest(`hex`);

interface Stored {
    useDays: { userId: string; extensionId: string; day: string }[];
    memberships: { userId: string; stripeCustomerId: string; stripeSubscriptionId: string; status: string; currentPeriodEnd: Date }[];
}

// Enough Prisma for these routes: the sandbox token lookup, membership reads/writes, and the use-day
// ledger with the unique-key dedupe createMany does for real.
const fakePrisma = (seed?: Partial<Stored>) => {
    const stored: Stored = { useDays: seed?.useDays ?? [], memberships: seed?.memberships ?? [] };
    const prisma = {
        sandbox: {
            findUnique: vi.fn(async ({ where }: { where: { tokenDigest: string } }) =>
                where.tokenDigest === digestOf(`tok`) ? { ownerId: `user-1` } : null,
            ),
        },
        extensionUseDay: {
            createMany: vi.fn(async ({ data }: { data: { userId: string; extensionId: string; day: string }[] }) => {
                const fresh = data.filter(
                    (row) =>
                        !stored.useDays.some(
                            (existing) => existing.userId === row.userId && existing.extensionId === row.extensionId && existing.day === row.day,
                        ),
                );
                stored.useDays.push(...fresh);
                return { count: fresh.length };
            }),
            findMany: vi.fn(async ({ where }: { where: { day: { gte: string } } }) =>
                stored.useDays.filter((row) => row.day >= where.day.gte),
            ),
        },
        membership: {
            findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
                stored.memberships.find((membership) => membership.userId === where.userId) ?? null,
            ),
            findMany: vi.fn(async () => stored.memberships),
            upsert: vi.fn(
                async ({ where, create, update }: { where: { userId: string }; create: Stored[`memberships`][number]; update: Partial<Stored[`memberships`][number]> }) => {
                    const existing = stored.memberships.find((membership) => membership.userId === where.userId);
                    if (existing === undefined) {
                        stored.memberships.push(create);
                        return create;
                    }
                    Object.assign(existing, update);
                    return existing;
                },
            ),
            updateMany: vi.fn(async ({ where, data }: { where: { stripeCustomerId: string }; data: Partial<Stored[`memberships`][number]> }) => {
                const hits = stored.memberships.filter((membership) => membership.stripeCustomerId === where.stripeCustomerId);
                for (const hit of hits) {
                    Object.assign(hit, data);
                }
                return { count: hits.length };
            }),
        },
    };
    return { prisma: prisma as unknown as PrismaClient, stored };
};

const call = (config: Config, prisma: PrismaClient, path: string, init?: RequestInit) =>
    createApp(config, prisma, logger).app.request(path, { ...init, headers: { "x-intentic-connect": `tok`, "content-type": `application/json`, ...init?.headers } });

const report = (config: Config, prisma: PrismaClient, rows: unknown, headers?: Record<string, string>) =>
    call(config, prisma, `/pool/report`, { method: `POST`, body: JSON.stringify({ rows }), headers });

describe(`the creator pool`, () => {
    it(`does not exist on a platform that sells nothing`, async () => {
        const { prisma } = fakePrisma();
        for (const path of [`/pool/status`, `/pool/transparency`]) {
            expect((await call(configWith({ stripeSecretKey: `` }), prisma, path)).status).toBe(404);
        }
    });

    it(`refuses a report from a token that belongs to no sandbox`, async () => {
        const { prisma } = fakePrisma();
        const response = await report(baseConfig, prisma, [], { "x-intentic-connect": `nope` });
        expect(response.status).toBe(404);
    });

    it(`lands reported days once, however often the tail is re-sent`, async () => {
        const { prisma, stored } = fakePrisma();
        const rows = [{ extensionId: `acme.research`, day: `2026-08-09` }, { extensionId: `acme.research`, day: `2026-08-10` }];
        expect((await report(baseConfig, prisma, rows)).status).toBe(200);
        expect((await report(baseConfig, prisma, rows)).status).toBe(200);
        expect(stored.useDays).toHaveLength(2);
        expect(stored.useDays[0]).toMatchObject({ userId: `user-1`, extensionId: `acme.research`, day: `2026-08-09` });
    });

    it(`drops days outside the accept window instead of back-filling published history`, async () => {
        const { prisma, stored } = fakePrisma();
        const response = await report(baseConfig, prisma, [
            { extensionId: `acme.research`, day: `2020-01-01` },
            { extensionId: `acme.research`, day: new Date().toISOString().slice(0, 10) },
        ]);
        expect(((await response.json()) as { accepted: number }).accepted).toBe(1);
        expect(stored.useDays).toHaveLength(1);
    });

    it(`refuses a malformed report outright`, async () => {
        const { prisma } = fakePrisma();
        expect((await report(baseConfig, prisma, [{ extensionId: `../../etc`, day: `2026-08-10` }])).status).toBe(400);
    });

    it(`answers premium only for a paid, current membership`, async () => {
        const paid = fakePrisma({
            memberships: [{ userId: `user-1`, stripeCustomerId: `cus_1`, stripeSubscriptionId: `sub_1`, status: `active`, currentPeriodEnd: NOW }],
        });
        expect(await (await call(baseConfig, paid.prisma, `/pool/status`)).json()).toEqual({ premium: true });

        const lapsed = fakePrisma({
            memberships: [{ userId: `user-1`, stripeCustomerId: `cus_1`, stripeSubscriptionId: `sub_1`, status: `past_due`, currentPeriodEnd: NOW }],
        });
        expect(await (await call(baseConfig, lapsed.prisma, `/pool/status`)).json()).toEqual({ premium: false });

        const nobody = fakePrisma();
        expect(await (await call(baseConfig, nobody.prisma, `/pool/status`)).json()).toEqual({ premium: false });
    });

    it(`publishes the ledger without a login, paying members' use and only that`, async () => {
        const day = new Date().toISOString().slice(0, 10);
        const month = day.slice(0, 7);
        const { prisma } = fakePrisma({
            memberships: [{ userId: `user-1`, stripeCustomerId: `cus_1`, stripeSubscriptionId: `sub_1`, status: `active`, currentPeriodEnd: NOW }],
            useDays: [
                { userId: `user-1`, extensionId: `acme.research`, day },
                { userId: `free-rider`, extensionId: `acme.research`, day },
            ],
        });
        // No connect token, no session — the transparency read is public by design.
        const response = await createApp(baseConfig, prisma, logger).app.request(`/pool/transparency`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { creatorShare: number; months: { month: string; poolCents: number; memberActiveDays: number; otherActiveDays: number; extensions: { extensionId: string; amountCents: number }[] }[] };
        expect(body.creatorShare).toBe(0.7);
        const current = body.months.find((entry) => entry.month === month);
        // 1 member × $20 × 70% = 1400 cents, all of it to the one extension the member used.
        expect(current).toMatchObject({ memberActiveDays: 1, otherActiveDays: 1, poolCents: 1400 });
        expect(current?.extensions).toEqual([{ extensionId: `acme.research`, activeDays: 1, share: 1, amountCents: 1400 }]);
    });

    it(`refuses an unsigned webhook and honours a signed subscription lapse`, async () => {
        const { prisma, stored } = fakePrisma({
            memberships: [{ userId: `user-1`, stripeCustomerId: `cus_1`, stripeSubscriptionId: `sub_1`, status: `active`, currentPeriodEnd: NOW }],
        });
        const gateway = { subscription: vi.fn() } as unknown as StripeGateway;
        const app = poolHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        const payload = JSON.stringify({
            type: `customer.subscription.deleted`,
            data: { object: { id: `sub_1`, customer: `cus_1`, status: `canceled`, current_period_end: Math.floor(NOW.getTime() / 1000) } },
        });

        const unsigned = await app.request(`/webhook`, { method: `POST`, body: payload });
        expect(unsigned.status).toBe(400);
        expect(stored.memberships[0]?.status).toBe(`active`);

        const timestamp = Math.floor(NOW.getTime() / 1000);
        const signature = createHmac(`sha256`, `whsec_test`).update(`${timestamp}.${payload}`).digest(`hex`);
        const signed = await app.request(`/webhook`, {
            method: `POST`,
            body: payload,
            headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        });
        expect(signed.status).toBe(200);
        expect(stored.memberships[0]?.status).toBe(`canceled`);
    });

    it(`turns a signed completed checkout into a membership`, async () => {
        const { prisma, stored } = fakePrisma();
        const gateway = {
            subscription: vi.fn(async () => ({ id: `sub_9`, customer: `cus_9`, status: `active`, currentPeriodEnd: NOW })),
        } as unknown as StripeGateway;
        const app = poolHttpRoutes({ config: baseConfig, prisma, gateway, now: () => NOW });
        const payload = JSON.stringify({
            type: `checkout.session.completed`,
            data: { object: { mode: `subscription`, client_reference_id: `user-1`, subscription: `sub_9` } },
        });
        const timestamp = Math.floor(NOW.getTime() / 1000);
        const signature = createHmac(`sha256`, `whsec_test`).update(`${timestamp}.${payload}`).digest(`hex`);
        const response = await app.request(`/webhook`, { method: `POST`, body: payload, headers: { "stripe-signature": `t=${timestamp},v1=${signature}` } });
        expect(response.status).toBe(200);
        expect(stored.memberships).toEqual([
            { userId: `user-1`, stripeCustomerId: `cus_9`, stripeSubscriptionId: `sub_9`, status: `active`, currentPeriodEnd: NOW },
        ]);
    });
});
