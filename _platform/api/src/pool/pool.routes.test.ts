import { createHash, createHmac } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { configSchema, type Config } from "../config.js";
import { seedDemoService } from "./pool-demo.js";
import type { StripeGateway } from "./pool-stripe.js";
import { poolHttpRoutes } from "./pool.routes.js";

/* THE POOL IS THE ROUTE FAMILY THE CREATOR PROMISE RESTS ON, so what is pinned here is what a creator or a
 * member would call betrayal if it drifted: the ledger only accepting what a real sandbox reported, premium
 * meaning a paid row (or the operator's own comp list) and nothing less, the public numbers adding up, and
 * the webhook refusing an unsigned event. */

const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const NOW = new Date(`2026-08-10T12:00:00Z`);

const baseConfig = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: `true` },
    zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
    trial: { keys: ``, baseUrl: `https://upstream.test/v1beta/openai`, models: ``, dailyMessages: 2 },
    pool: {
        stripeSecretKey: `sk_test`,
        stripeWebhookSecret: `whsec_test`,
        stripePriceId: `price_1`,
        priceUsd: 20,
        infraUsd: 5,
        creatorShare: 0.9,
        dailyCredits: 100,
        serviceShare: 0.9,
        donationCredits: 50,
        demoService: `false`,
    },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

const configWith = (pool: Partial<Config[`pool`]>): Config => ({ ...baseConfig, pool: { ...baseConfig.pool, ...pool } });

const digestOf = (token: string) => createHash(`sha256`).update(token).digest(`hex`);

interface Stored {
    donations: { userId: string; extensionId: string; month: string; credits: number }[];
    users: { id: string; email: string }[];
    memberships: { userId: string; stripeCustomerId: string; stripeSubscriptionId: string; status: string; currentPeriodEnd: Date }[];
    services: {
        id: string;
        slug: string;
        publisher: string;
        name: string;
        description: string;
        upstreamUrl: string;
        secret: string;
        creditsPerRun: number;
        sampleRequest: string;
        status: string;
    }[];
    creditSpends: Map<string, number>;
    serviceRuns: { userId: string; serviceId: string; credits: number; status: string; createdAt: Date }[];
    serviceWants: { userId: string; text: string; normalized: string; createdAt: Date }[];
}

// Enough Prisma for these routes: the sandbox token lookup, membership reads/writes, and the donation
// ledger with the unique key create enforces for real.
const fakePrisma = (seed?: Partial<Stored>) => {
    const stored: Stored = {
        donations: seed?.donations ?? [],
        users: seed?.users ?? [],
        memberships: seed?.memberships ?? [],
        services: seed?.services ?? [],
        creditSpends: seed?.creditSpends ?? new Map(),
        serviceRuns: seed?.serviceRuns ?? [],
        serviceWants: seed?.serviceWants ?? [],
    };
    const prisma = {
        sandbox: {
            findUnique: vi.fn(async ({ where }: { where: { tokenDigest: string } }) =>
                where.tokenDigest === digestOf(`tok`) ? { ownerId: `user-1` } : null,
            ),
        },
        user: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => stored.users.find((user) => user.id === where.id) ?? null),
        },
        donation: {
            findUnique: vi.fn(async ({ where }: { where: { userId_extensionId_month: { userId: string; extensionId: string; month: string } } }) => {
                const key = where.userId_extensionId_month;
                return (
                    stored.donations.find((row) => row.userId === key.userId && row.extensionId === key.extensionId && row.month === key.month) ??
                    null
                );
            }),
            create: vi.fn(async ({ data }: { data: Stored[`donations`][number] }) => {
                const clash = stored.donations.some(
                    (row) => row.userId === data.userId && row.extensionId === data.extensionId && row.month === data.month,
                );
                if (clash) {
                    throw new Error(`unique constraint`);
                }
                stored.donations.push(data);
                return data;
            }),
            // The ledger reads ONE month of donations now: the open one, because every earlier month is
            // served from its frozen record rather than recomputed.
            findMany: vi.fn(async ({ where }: { where: { month: string } }) => stored.donations.filter((row) => row.month === where.month)),
        },
        membership: {
            findUnique: vi.fn(
                async ({ where }: { where: { userId: string } }) =>
                    stored.memberships.find((membership) => membership.userId === where.userId) ?? null,
            ),
            findMany: vi.fn(async () => stored.memberships),
            upsert: vi.fn(
                async ({
                    where,
                    create,
                    update,
                }: {
                    where: { userId: string };
                    create: Stored[`memberships`][number];
                    update: Partial<Stored[`memberships`][number]>;
                }) => {
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
        // The ledger's closed-month half. These suites exercise the OPEN month: the frozen record has its own
        // suite (pool-close.test.ts), so a platform with nothing closed yet is exactly the right fixture.
        poolMonth: { findMany: vi.fn(async () => []) },
        publisherClaim: { findMany: vi.fn(async () => []) },
        service: {
            findUnique: vi.fn(
                async ({ where }: { where: { slug: string } }) => stored.services.find((service) => service.slug === where.slug) ?? null,
            ),
            // Honors the caller's own `where.status.in` and `select`, because two routes read listings in
            // different shapes now: the sandbox catalog (/services) and the public one (/catalog).
            findMany: vi.fn(async ({ where, select }: { where: { status: { in: string[] } }; select: Record<string, true | undefined> }) =>
                stored.services
                    .filter((service) => where.status.in.includes(service.status))
                    .map((service) => Object.fromEntries(Object.entries(service).filter(([key]) => select[key] === true))),
            ),
        },
        creditSpend: {
            findUnique: vi.fn(async ({ where }: { where: { userId_day: { userId: string; day: string } } }) => {
                const value = stored.creditSpends.get(`${where.userId_day.userId}:${where.userId_day.day}`);
                return value === undefined ? null : { credits: value };
            }),
            upsert: vi.fn(
                async ({
                    where,
                    create,
                    update,
                }: {
                    where: { userId_day: { userId: string; day: string } };
                    create: { credits: number };
                    update: { credits: { increment: number } };
                }) => {
                    const key = `${where.userId_day.userId}:${where.userId_day.day}`;
                    const next = stored.creditSpends.has(key) ? (stored.creditSpends.get(key) ?? 0) + update.credits.increment : create.credits;
                    stored.creditSpends.set(key, next);
                    return { credits: next };
                },
            ),
            update: vi.fn(
                async ({ where, data }: { where: { userId_day: { userId: string; day: string } }; data: { credits: { decrement: number } } }) => {
                    const key = `${where.userId_day.userId}:${where.userId_day.day}`;
                    stored.creditSpends.set(key, (stored.creditSpends.get(key) ?? 0) - data.credits.decrement);
                    return { credits: stored.creditSpends.get(key) };
                },
            ),
            updateMany: vi.fn(
                async ({ where, data }: { where: { userId: string; day: string; credits: { lt: number } }; data: { credits: number } }) => {
                    const key = `${where.userId}:${where.day}`;
                    if ((stored.creditSpends.get(key) ?? 0) < 0) {
                        stored.creditSpends.set(key, data.credits);
                    }
                    return { count: 0 };
                },
            ),
        },
        serviceWant: {
            count: vi.fn(
                async ({ where }: { where: { userId: string; createdAt: { gte: Date } } }) =>
                    stored.serviceWants.filter((row) => row.userId === where.userId && row.createdAt >= where.createdAt.gte).length,
            ),
            create: vi.fn(async ({ data }: { data: { userId: string; text: string; normalized: string } }) => {
                const row = { ...data, createdAt: NOW };
                stored.serviceWants.push(row);
                return row;
            }),
            findMany: vi.fn(async ({ where }: { where: { createdAt: { gte: Date } } }) =>
                stored.serviceWants
                    .filter((row) => row.createdAt >= where.createdAt.gte)
                    .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                    .map(({ userId, text, normalized, createdAt }) => ({ userId, text, normalized, createdAt })),
            ),
        },
        serviceRun: {
            create: vi.fn(async ({ data }: { data: { userId: string; serviceId: string; credits: number; status: string } }) => {
                const row = { ...data, createdAt: new Date() };
                stored.serviceRuns.push(row);
                return row;
            }),
            findMany: vi.fn(async ({ where }: { where: { status: string; createdAt: { gte: Date } } }) =>
                stored.serviceRuns
                    .filter((run) => run.status === where.status && run.createdAt >= where.createdAt.gte)
                    .map((run) => {
                        const service = stored.services.find((candidate) => candidate.id === run.serviceId);
                        return {
                            credits: run.credits,
                            createdAt: run.createdAt,
                            service: { slug: service?.slug ?? `?`, publisher: service?.publisher ?? `?` },
                        };
                    }),
            ),
            // The grouped lifetime counts behind creator-services.ts countsOf, which the public catalog reads.
            groupBy: vi.fn(async ({ where }: { where: { serviceId: { in: string[] } } }) => {
                const tally = new Map<string, number>();
                for (const run of stored.serviceRuns.filter((candidate) => where.serviceId.in.includes(candidate.serviceId))) {
                    const key = `${run.serviceId}\u0000${run.status}`;
                    tally.set(key, (tally.get(key) ?? 0) + 1);
                }
                return [...tally].map(([key, count]) => {
                    const [serviceId = ``, status = ``] = key.split(`\u0000`);
                    return { serviceId, status, _count: { _all: count } };
                });
            }),
        },
    };
    return { prisma: prisma as unknown as PrismaClient, stored };
};

const call = (config: Config, prisma: PrismaClient, path: string, init?: RequestInit) =>
    createApp(config, prisma, logger).app.request(path, {
        ...init,
        headers: { "x-intentic-connect": `tok`, "content-type": `application/json`, ...init?.headers },
    });

const MEMBER_ROW = {
    userId: `user-1`,
    stripeCustomerId: `cus_1`,
    stripeSubscriptionId: `sub_1`,
    status: `active`,
    currentPeriodEnd: new Date(`2026-08-10T12:00:00Z`),
};

const donate = (config: Config, prisma: PrismaClient, extensionId: string, headers?: Record<string, string>) =>
    call(config, prisma, `/pool/donate`, { method: `POST`, body: JSON.stringify({ extensionId }), headers });

describe(`the creator pool`, () => {
    it(`does not exist on a platform that sells nothing`, async () => {
        const { prisma } = fakePrisma();
        for (const path of [`/pool/status`, `/pool/transparency`]) {
            expect((await call(configWith({ stripeSecretKey: `` }), prisma, path)).status).toBe(404);
        }
    });

    it(`refuses a donation from a token that belongs to no sandbox`, async () => {
        const { prisma } = fakePrisma();
        const response = await donate(baseConfig, prisma, `acme.research`, { "x-intentic-connect": `nope` });
        expect(response.status).toBe(404);
    });

    it(`refuses a non-member's donation with the way forward, charging nothing`, async () => {
        const { prisma, stored } = fakePrisma();
        const response = await donate(baseConfig, prisma, `acme.research`);
        expect(response.status).toBe(403);
        expect(stored.donations).toEqual([]);
        expect(stored.creditSpends.size).toBe(0);
    });

    it(`donates once per month: the install pays, the reinstall answers "already supported"`, async () => {
        const { prisma, stored } = fakePrisma({ memberships: [MEMBER_ROW] });
        const month = new Date().toISOString().slice(0, 7);
        const first = (await (await donate(baseConfig, prisma, `acme.research`)).json()) as { donated: number; remaining: number };
        expect(first).toMatchObject({ donated: 50 });
        const second = (await (await donate(baseConfig, prisma, `acme.research`)).json()) as { donated: number };
        expect(second.donated).toBe(0);
        expect(stored.donations).toEqual([{ userId: `user-1`, extensionId: `acme.research`, month, credits: 50 }]);
        // One donation's worth of credits spent, not two.
        expect([...stored.creditSpends.values()]).toEqual([50]);
    });

    it(`refuses a donation past the daily allowance and gives the optimistic bite back`, async () => {
        const day = new Date().toISOString().slice(0, 10);
        const { prisma, stored } = fakePrisma({ memberships: [MEMBER_ROW], creditSpends: new Map([[`user-1:${day}`, 80]]) });
        const response = await donate(baseConfig, prisma, `acme.research`);
        expect(response.status).toBe(429);
        expect(((await response.json()) as { error: { type: string } }).error.type).toBe(`insufficient_credits`);
        expect(stored.donations).toEqual([]);
        expect(stored.creditSpends.get(`user-1:${day}`)).toBe(80);
    });

    it(`refuses a malformed donation outright`, async () => {
        const { prisma } = fakePrisma({ memberships: [MEMBER_ROW] });
        expect((await donate(baseConfig, prisma, `../../etc`)).status).toBe(400);
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

    it(`answers premium for an email on the comp list, with no membership row at all`, async () => {
        const comped = configWith({ compEmails: ` Dev@Example.com , other@example.com` });
        const { prisma } = fakePrisma({ users: [{ id: `user-1`, email: `dev@example.com` }] });
        expect(await (await call(comped, prisma, `/pool/status`)).json()).toEqual({ premium: true });
        // Off the list, back to the paid rule: nothing was ever written down.
        expect(await (await call(baseConfig, prisma, `/pool/status`)).json()).toEqual({ premium: false });
    });

    it(`publishes the ledger without a login, paying what the donations actually carried`, async () => {
        const month = new Date().toISOString().slice(0, 7);
        const { prisma } = fakePrisma({
            memberships: [{ userId: `user-1`, stripeCustomerId: `cus_1`, stripeSubscriptionId: `sub_1`, status: `active`, currentPeriodEnd: NOW }],
            donations: [{ userId: `user-1`, extensionId: `acme.research`, month, credits: 50 }],
        });
        // No connect token, no session: the transparency read is public by design.
        const response = await createApp(baseConfig, prisma, logger).app.request(`/pool/transparency`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            creatorShare: number;
            donationCredits: number;
            months: {
                month: string;
                state: string;
                poolCents: number;
                earnedCents: number;
                estimatedGrossCents: number;
                estimatedInfraCents: number;
                extensions: { extensionId: string; donors: number; credits: number; earningsCents: number }[];
            }[];
        };
        expect(body.creatorShare).toBe(0.9);
        expect(body.donationCredits).toBe(50);
        const current = body.months.find((entry) => entry.month === month);
        // Ceiling: 1 member × ($20 − $5 infrastructure) × 90% = 1350¢. Earned: 50 credits × (1500¢/3000) ×
        // 90% = 22¢: the ledger states both, so nobody can read the ceiling as a promise.
        expect(current).toMatchObject({ state: `open`, poolCents: 1350, earnedCents: 22 });
        // The month in progress cannot know what it took, so its revenue is named as the estimate it is:
        // and what infrastructure took out of it is estimated on the same basis and published beside it.
        expect(current?.estimatedGrossCents).toBe(2000);
        expect(current?.estimatedInfraCents).toBe(500);
        expect(current).not.toHaveProperty(`grossCents`);
        expect(current?.extensions).toEqual([{ extensionId: `acme.research`, donors: 1, credits: 50, earningsCents: 22 }]);
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
        const response = await app.request(`/webhook`, {
            method: `POST`,
            body: payload,
            headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        });
        expect(response.status).toBe(200);
        expect(stored.memberships).toEqual([
            { userId: `user-1`, stripeCustomerId: `cus_9`, stripeSubscriptionId: `sub_9`, status: `active`, currentPeriodEnd: NOW },
        ]);
    });
});

const RESEARCH = {
    id: `svc_1`,
    slug: `acme-research`,
    publisher: `acme`,
    name: `Acme Research`,
    description: `Deep research runs.`,
    upstreamUrl: `https://svc.acme.test/run`,
    secret: `svc-secret`,
    creditsPerRun: 40,
    sampleRequest: `{"query":"a worked example"}`,
    status: `listed`,
};

const MEMBER = { userId: `user-1`, stripeCustomerId: `cus_1`, stripeSubscriptionId: `sub_1`, status: `active`, currentPeriodEnd: NOW };

describe(`metered service runs`, () => {
    const run = (prisma: PrismaClient, fetchFn: typeof fetch, body = `{"query":"launch on reddit"}`) =>
        poolHttpRoutes({ config: baseConfig, prisma, fetchFn, now: () => NOW }).request(`/services/acme-research/run`, {
            method: `POST`,
            body,
            headers: { "x-intentic-connect": `tok`, "content-type": `application/json` },
        });

    it(`lists the catalog with the member's meter beside it`, async () => {
        const { prisma } = fakePrisma({ services: [RESEARCH], memberships: [MEMBER], creditSpends: new Map([[`user-1:2026-08-10`, 25]]) });
        // The route reads "today" from its own clock; drive it through poolHttpRoutes directly for a fixed NOW.
        const app = poolHttpRoutes({ config: baseConfig, prisma, now: () => NOW });
        const body = (await (await app.request(`/services`, { headers: { "x-intentic-connect": `tok` } })).json()) as {
            member: boolean;
            services: { slug: string; creditsPerRun: number }[];
            credits?: { remaining: number };
        };
        expect(body.member).toBe(true);
        // `status` is flattened to `probation` on the way out: the catalog's readers need "is this new",
        // never the lifecycle vocabulary, and the provider's worked example rides along for the agent.
        expect(body.services).toEqual([
            {
                slug: `acme-research`,
                publisher: `acme`,
                name: `Acme Research`,
                description: `Deep research runs.`,
                creditsPerRun: 40,
                sampleRequest: `{"query":"a worked example"}`,
                probation: false,
            },
        ]);
        expect(body.credits?.remaining).toBe(75);
    });

    it(`refuses a non-member with the way forward, spending nothing`, async () => {
        const { prisma, stored } = fakePrisma({ services: [RESEARCH] });
        const fetchFn = vi.fn();
        const response = await run(prisma, fetchFn as unknown as typeof fetch);
        expect(response.status).toBe(403);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(stored.serviceRuns).toEqual([]);
    });

    it(`spends, forwards signed, and relays the provider's stream with the ledger's receipt on the end`, async () => {
        const { prisma, stored } = fakePrisma({ services: [RESEARCH], memberships: [MEMBER] });
        const requestBody = `{"query":"launch on reddit"}`;
        const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            expect(String(url)).toBe(`https://svc.acme.test/run`);
            const headers = init?.headers as Record<string, string>;
            // The provider's whole verification: HMAC of "{timestamp}.{body}" with the shared secret.
            const expected = createHmac(`sha256`, `svc-secret`).update(`${headers[`x-intentic-timestamp`]}.${requestBody}`).digest(`hex`);
            expect(headers[`x-intentic-signature`]).toBe(expected);
            return new Response(`{"event":"status","text":"digging"}\n{"event":"result","data":{"answer":42}}\n`, {
                status: 200,
                headers: { "content-type": `application/x-ndjson` },
            });
        });
        const response = await run(prisma, fetchFn as unknown as typeof fetch, requestBody);
        expect(response.status).toBe(200);
        expect(response.headers.get(`content-type`)).toBe(`application/x-ndjson`);
        const lines = (await response.text())
            .trim()
            .split(`\n`)
            .map((line) => JSON.parse(line) as object);
        expect(lines).toEqual([
            { event: `status`, text: `digging` },
            { event: `result`, data: { answer: 42 } },
            // The trailer is the platform's, never the provider's: outcome and the meter after the charge.
            { event: `receipt`, outcome: `ok`, credits: 40, remaining: 60 },
        ]);
        expect(stored.creditSpends.get(`user-1:2026-08-10`)).toBe(40);
        expect(stored.serviceRuns).toMatchObject([{ userId: `user-1`, serviceId: `svc_1`, credits: 40, status: `ok` }]);
    });

    it(`refunds a stream that dies before its result: on the open stream, via the trailer`, async () => {
        const { prisma, stored } = fakePrisma({ services: [RESEARCH], memberships: [MEMBER] });
        const fetchFn = vi.fn(
            async () => new Response(`{"event":"status","text":"digging"}\n`, { status: 200, headers: { "content-type": `application/x-ndjson` } }),
        );
        const response = await run(prisma, fetchFn as unknown as typeof fetch);
        // The status line already crossed the wire before the stream died, so the refusal cannot be an HTTP
        // status: the refund is the trailer's word, and the ledger agrees.
        expect(response.status).toBe(200);
        const lines = (await response.text())
            .trim()
            .split(`\n`)
            .map((line) => JSON.parse(line) as object);
        expect(lines).toEqual([
            { event: `status`, text: `digging` },
            { event: `receipt`, outcome: `refunded`, credits: 40 },
        ]);
        expect(stored.creditSpends.get(`user-1:2026-08-10`)).toBe(0);
        expect(stored.serviceRuns).toMatchObject([{ status: `refunded` }]);
    });

    it(`refunds a 2xx that is not the event format: a misbehaving provider did not serve`, async () => {
        const { prisma, stored } = fakePrisma({ services: [RESEARCH], memberships: [MEMBER] });
        const fetchFn = vi.fn(async () => new Response(`{"answer":42}`, { status: 200, headers: { "content-type": `application/json` } }));
        const response = await run(prisma, fetchFn as unknown as typeof fetch);
        expect(response.status).toBe(200);
        const lines = (await response.text())
            .trim()
            .split(`\n`)
            .map((line) => JSON.parse(line) as object);
        expect(lines).toEqual([{ event: `receipt`, outcome: `refunded`, credits: 40 }]);
        expect(stored.creditSpends.get(`user-1:2026-08-10`)).toBe(0);
        expect(stored.serviceRuns).toMatchObject([{ status: `refunded` }]);
    });

    it(`serves a result whose line the stream never terminated`, async () => {
        const { prisma, stored } = fakePrisma({ services: [RESEARCH], memberships: [MEMBER] });
        const fetchFn = vi.fn(
            async () => new Response(`{"event":"result","data":7}`, { status: 200, headers: { "content-type": `application/x-ndjson` } }),
        );
        const response = await run(prisma, fetchFn as unknown as typeof fetch);
        const lines = (await response.text())
            .trim()
            .split(`\n`)
            .map((line) => JSON.parse(line) as object);
        expect(lines).toEqual([
            { event: `result`, data: 7 },
            { event: `receipt`, outcome: `ok`, credits: 40, remaining: 60 },
        ]);
        expect(stored.serviceRuns).toMatchObject([{ status: `ok` }]);
    });

    it(`refunds a provider that failed to serve, and the run row says so`, async () => {
        const { prisma, stored } = fakePrisma({ services: [RESEARCH], memberships: [MEMBER] });
        const fetchFn = vi.fn(async () => new Response(`boom`, { status: 500 }));
        const response = await run(prisma, fetchFn as unknown as typeof fetch);
        expect(response.status).toBe(502);
        expect(((await response.json()) as { error: { type: string } }).error.type).toBe(`service_unavailable`);
        expect(stored.creditSpends.get(`user-1:2026-08-10`)).toBe(0);
        expect(stored.serviceRuns).toMatchObject([{ status: `refunded` }]);
    });

    it(`a provider's 4xx is an answer: paid for, relayed verbatim`, async () => {
        const { prisma, stored } = fakePrisma({ services: [RESEARCH], memberships: [MEMBER] });
        const fetchFn = vi.fn(async () => new Response(`{"error":"query too broad"}`, { status: 422 }));
        const response = await run(prisma, fetchFn as unknown as typeof fetch);
        expect(response.status).toBe(422);
        expect(stored.creditSpends.get(`user-1:2026-08-10`)).toBe(40);
        expect(stored.serviceRuns).toMatchObject([{ status: `ok` }]);
    });

    it(`refuses past the allowance with the reset time, and gives the optimistic bite back`, async () => {
        const { prisma, stored } = fakePrisma({
            services: [RESEARCH],
            memberships: [MEMBER],
            creditSpends: new Map([[`user-1:2026-08-10`, 80]]),
        });
        const fetchFn = vi.fn();
        const response = await run(prisma, fetchFn as unknown as typeof fetch);
        expect(response.status).toBe(429);
        const body = (await response.json()) as { error: { type: string }; credits: { resetsAt: string } };
        expect(body.error.type).toBe(`insufficient_credits`);
        expect(body.credits.resetsAt).toBe(`2026-08-11T00:00:00.000Z`);
        expect(fetchFn).not.toHaveBeenCalled();
        // The refused attempt's increment was refunded: the member still holds their real remainder.
        expect(stored.creditSpends.get(`user-1:2026-08-10`)).toBe(80);
    });

    /* The demo service, seeded. No fetch is injected on purpose: the route dispatches a demo forward into
     * its own app (its upstream IS this app), and these suites prove that production path: spend → sign →
     * verify → answer → relay with the meter on it: with no seam standing in for any of it. */
    const demoSetup = async () => {
        const demoConfig = configWith({ demoService: true });
        const { prisma, stored } = fakePrisma({ memberships: [MEMBER] });
        // Give the fake enough of `service.create`/`update` for the seeder.
        const prismaAny = prisma as unknown as {
            service: {
                create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
                update: (args: { where: { slug: string }; data: Record<string, unknown> }) => Promise<unknown>;
            };
        };
        prismaAny.service.create = async ({ data }) => {
            stored.services.push({ id: `svc_demo`, ...(data as Omit<Stored[`services`][number], `id`>) });
            return data;
        };
        prismaAny.service.update = async ({ where, data }) => {
            const row = stored.services.find((service) => service.slug === where.slug);
            Object.assign(row ?? {}, data);
            return row;
        };
        await seedDemoService(prisma, demoConfig);
        const app = poolHttpRoutes({ config: demoConfig, prisma, now: () => NOW });
        const runDemo = async (body: object) => {
            const response = await app.request(`/services/demo-research/run`, {
                method: `POST`,
                body: JSON.stringify(body),
                headers: { "x-intentic-connect": `tok`, "content-type": `application/json` },
            });
            return response;
        };
        return { app, stored, runDemo };
    };

    const linesOf = async (response: Response) =>
        (await response.text())
            .trim()
            .split(`\n`)
            .map((line) => JSON.parse(line) as { event: string; text?: string; data?: { demo?: boolean; query?: string }; remaining?: number });

    it(`serves the demo service end to end: seeded, signed, verified, answered, metered`, async () => {
        const { app, stored, runDemo } = await demoSetup();
        expect(stored.services).toMatchObject([{ slug: `demo-research`, publisher: `intentic`, creditsPerRun: 5, status: `listed` }]);

        const response = await runDemo({ query: `launch on reddit`, paceMs: 0 });
        expect(response.status).toBe(200);
        const lines = await linesOf(response);
        // The demo streams like any provider: status lines, its result, then the platform's receipt.
        expect(lines.map((line) => line.event)).toEqual([`status`, `status`, `result`, `receipt`]);
        expect(lines[2]?.data?.demo).toBe(true);
        expect(lines[2]?.data?.query).toBe(`launch on reddit`);
        expect(lines[3]).toMatchObject({ event: `receipt`, outcome: `ok`, credits: 5, remaining: 95 });
        expect(stored.serviceRuns).toMatchObject([{ credits: 5, status: `ok` }]);

        // And the intermediary promise holds: an unsigned call straight at the upstream is refused.
        const unsigned = await app.request(`/demo/upstream`, { method: `POST`, body: `{"query":"x"}` });
        expect(unsigned.status).toBe(401);
    });

    /* The demo's scenarios: every way a metered run can settle, reproducible on demand (pool-demo.ts). Each
     * one exists so the spend card's every look (paid refusal, refunded failure, refunded broken stream, the
     * long run) can be produced deliberately instead of waiting for a provider to fail interestingly. */
    it(`demo "refuse" is a provider 4xx: a complete answer, paid for, relayed verbatim`, async () => {
        const { stored, runDemo } = await demoSetup();
        const response = await runDemo({ query: `x`, scenario: `refuse` });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { type: string } }).error.type).toBe(`demo_refusal`);
        expect(stored.creditSpends.get(`user-1:2026-08-10`)).toBe(5);
        expect(stored.serviceRuns).toMatchObject([{ credits: 5, status: `ok` }]);
    });

    it(`demo "fail" is a provider 5xx: nothing served, the run refunded`, async () => {
        const { stored, runDemo } = await demoSetup();
        const response = await runDemo({ query: `x`, scenario: `fail` });
        expect(response.status).toBe(502);
        expect(((await response.json()) as { error: { type: string } }).error.type).toBe(`service_unavailable`);
        expect(stored.creditSpends.get(`user-1:2026-08-10`)).toBe(0);
        expect(stored.serviceRuns).toMatchObject([{ credits: 5, status: `refunded` }]);
    });

    it(`demo "broken" streams then dies without a result: refunded via the trailer`, async () => {
        const { stored, runDemo } = await demoSetup();
        const response = await runDemo({ query: `x`, scenario: `broken`, paceMs: 0 });
        expect(response.status).toBe(200);
        const lines = await linesOf(response);
        expect(lines.map((line) => line.event)).toEqual([`status`, `status`, `receipt`]);
        expect(lines.at(-1)).toMatchObject({ event: `receipt`, outcome: `refunded`, credits: 5 });
        expect(stored.creditSpends.get(`user-1:2026-08-10`)).toBe(0);
        expect(stored.serviceRuns).toMatchObject([{ credits: 5, status: `refunded` }]);
    });

    it(`demo "slow" is the long run: more status lines, same served ending`, async () => {
        const { stored, runDemo } = await demoSetup();
        const response = await runDemo({ query: `x`, scenario: `slow`, paceMs: 0 });
        const lines = await linesOf(response);
        expect(lines.filter((line) => line.event === `status`).length).toBeGreaterThan(4);
        expect(lines.at(-1)).toMatchObject({ event: `receipt`, outcome: `ok`, credits: 5 });
        expect(stored.serviceRuns).toMatchObject([{ credits: 5, status: `ok` }]);
    });

    it(`publishes service earnings beside donations, refunded runs earning nothing`, async () => {
        const month = new Date().toISOString().slice(0, 7);
        const { prisma } = fakePrisma({
            services: [RESEARCH],
            memberships: [MEMBER],
            donations: [{ userId: `user-1`, extensionId: `acme.research`, month, credits: 50 }],
            serviceRuns: [
                { userId: `user-1`, serviceId: `svc_1`, credits: 40, status: `ok`, createdAt: new Date() },
                { userId: `user-1`, serviceId: `svc_1`, credits: 40, status: `refunded`, createdAt: new Date() },
            ],
        });
        const response = await createApp(baseConfig, prisma, logger).app.request(`/pool/transparency`);
        const body = (await response.json()) as {
            serviceShare: number;
            months: {
                month: string;
                poolCents: number;
                earnedCents: number;
                services: { slug: string; runs: number; credits: number; earningsCents: number }[];
                extensions: { extensionId: string; earningsCents: number }[];
            }[];
        };
        expect(body.serviceShare).toBe(0.9);
        const current = body.months.find((entry) => entry.month === month);
        /* One member's $20, less the $5 of infrastructure, is a $15 pool, so credit value = 1500¢/3000 = ½¢
         * and the ceiling is 90% of 1500¢. Service: 40 ok credits × ½¢ × 90% = 18¢ (the refunded run earns
         * nothing). Donation: 50 credits × ½¢ × 90% = 22.5 → 22¢. Both on the same ledger, side by side. */
        expect(current?.services).toEqual([{ slug: `acme-research`, publisher: `acme`, runs: 1, credits: 40, earningsCents: 18 }]);
        expect(current?.extensions).toMatchObject([{ extensionId: `acme.research`, earningsCents: 22 }]);
        // The infrastructure line is published, not merely subtracted: the pool figure beside it is checkable
        // only if a reader can see what came off the gross first.
        expect(current).toMatchObject({ estimatedGrossCents: 2000, estimatedInfraCents: 500, poolCents: 1350, earnedCents: 40 });
    });
});

describe(`the public catalog`, () => {
    it(`does not exist on a platform that sells nothing`, async () => {
        const { prisma } = fakePrisma();
        expect((await createApp(configWith({ stripeSecretKey: `` }), prisma, logger).app.request(`/pool/catalog`)).status).toBe(404);
    });

    it(`answers anyone (no token) with the live listings and their public run numbers`, async () => {
        const { prisma } = fakePrisma({
            services: [
                RESEARCH,
                { ...RESEARCH, id: `svc_2`, slug: `beta-lookup`, publisher: `beta`, name: `Beta Lookup`, status: `probation` },
                { ...RESEARCH, id: `svc_3`, slug: `gone`, status: `draft` },
            ],
            serviceRuns: [
                { userId: `user-1`, serviceId: `svc_1`, credits: 40, status: `ok`, createdAt: NOW },
                { userId: `user-1`, serviceId: `svc_1`, credits: 40, status: `ok`, createdAt: NOW },
                { userId: `user-1`, serviceId: `svc_1`, credits: 40, status: `refunded`, createdAt: NOW },
            ],
        });
        // No x-intentic-connect header at all: the whole point of this surface is that it needs nothing.
        const response = await createApp(baseConfig, prisma, logger).app.request(`/pool/catalog`);
        expect(response.status).toBe(200);
        // Cross-origin like the transparency ledger: the site reads it from a different host.
        expect(response.headers.get(`access-control-allow-origin`)).toBe(`*`);
        const body = (await response.json()) as { services: Record<string, unknown>[] };
        // Drafts are invisible, probation is one boolean, and the refunded run is on the public record. What
        // is NOT here matters as much: no sample request, no upstream URL, no ids, and nothing member-shaped.
        expect(body.services).toEqual([
            {
                slug: `acme-research`,
                publisher: `acme`,
                name: `Acme Research`,
                description: `Deep research runs.`,
                creditsPerRun: 40,
                probation: false,
                servedRuns: 2,
                refundedRuns: 1,
            },
            {
                slug: `beta-lookup`,
                publisher: `beta`,
                name: `Beta Lookup`,
                description: `Deep research runs.`,
                creditsPerRun: 40,
                probation: true,
                servedRuns: 0,
                refundedRuns: 0,
            },
        ]);
    });
});

describe(`the wanted list`, () => {
    const want = (prisma: PrismaClient, text: string) =>
        poolHttpRoutes({ config: baseConfig, prisma, now: () => NOW }).request(`/wanted`, {
            method: `POST`,
            body: JSON.stringify({ text }),
            headers: { "x-intentic-connect": `tok`, "content-type": `application/json` },
        });

    it(`records a want, normalized, and answers nothing about anyone`, async () => {
        const { prisma, stored } = fakePrisma();
        const response = await want(prisma, `  Watermark-free PDF  Invoice extraction `);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ recorded: true });
        expect(stored.serviceWants).toMatchObject([
            { userId: `user-1`, text: `Watermark-free PDF  Invoice extraction`, normalized: `watermark-free pdf invoice extraction` },
        ]);
    });

    it(`bounds the text and the day: a sixth want is refused, charging nothing either way`, async () => {
        const seed = Array.from({ length: 5 }, (_, index) => ({
            userId: `user-1`,
            text: `ask ${index} long enough`,
            normalized: `ask ${index} long enough`,
            createdAt: NOW,
        }));
        const { prisma, stored } = fakePrisma({ serviceWants: seed });
        expect((await want(prisma, `short`)).status).toBe(400);
        expect((await want(prisma, `a sixth perfectly reasonable ask`)).status).toBe(429);
        expect(stored.serviceWants).toHaveLength(5);
        // No membership required: a non-member's unmet need is future demand, and nothing is spent.
        expect(stored.creditSpends.size).toBe(0);
    });

    it(`publishes the aggregate on the catalog: distinct owners, one row per normalized ask, newest last word`, async () => {
        const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * 86_400_000);
        const { prisma } = fakePrisma({
            serviceWants: [
                { userId: `user-1`, text: `PDF invoice extraction`, normalized: `pdf invoice extraction`, createdAt: at(-2) },
                // The same ask from the same owner twice is still ONE voice.
                { userId: `user-1`, text: `pdf  Invoice   extraction`, normalized: `pdf invoice extraction`, createdAt: at(-1) },
                { userId: `user-2`, text: `pdf invoice extraction`, normalized: `pdf invoice extraction`, createdAt: at(0) },
                { userId: `user-2`, text: `flight price lookups`, normalized: `flight price lookups`, createdAt: at(0) },
                // Outside the 90-day window: gone from the aggregate.
                { userId: `user-3`, text: `pdf invoice extraction`, normalized: `pdf invoice extraction`, createdAt: at(-120) },
            ],
        });
        const app = poolHttpRoutes({ config: baseConfig, prisma, now: () => NOW });
        const body = (await (await app.request(`/catalog`)).json()) as { wanted: { text: string; count: number; lastAt: string }[] };
        expect(body.wanted).toEqual([
            { text: `pdf invoice extraction`, count: 2, lastAt: NOW.toISOString() },
            { text: `flight price lookups`, count: 1, lastAt: NOW.toISOString() },
        ]);
    });

    it(`refuses a token that belongs to no sandbox`, async () => {
        const { prisma, stored } = fakePrisma();
        const response = await poolHttpRoutes({ config: baseConfig, prisma, now: () => NOW }).request(`/wanted`, {
            method: `POST`,
            body: JSON.stringify({ text: `a perfectly reasonable ask` }),
            headers: { "x-intentic-connect": `nope`, "content-type": `application/json` },
        });
        expect(response.status).toBe(404);
        expect(stored.serviceWants).toEqual([]);
    });
});
