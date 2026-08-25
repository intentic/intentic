import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { requireAdmin } from "../guards.js";
import { adminAttention } from "./admin-attention.js";
import { adminCosts } from "./admin-costs.js";
import { adminFunnel } from "./admin-funnel.js";
import { adminOverview } from "./admin-overview.js";
import { adminRoutes } from "./admin.routes.js";
import { adminUserDetail } from "./admin-user.js";
import { adminUsers } from "./admin-users.js";

/* THE ADMIN SURFACE'S WHOLE SECURITY STORY IS ONE GUARD, so the things worth pinning are the refusals: an
 * empty allowlist refusing everyone (a fresh self-hosted platform has no admin surface), a signed-in
 * non-admin reading FORBIDDEN rather than data, and the allowlist matching by address rather than by
 * spelling (case and whitespace are presentation, not identity). Below that, each read module is pinned on
 * the arithmetic that would lie silently if it drifted: funnel stages, attention sentences and ordering,
 * cost aggregation against config knobs, and the support page's shape. */

const NOW = new Date(`2026-08-25T10:30:00Z`);

// The slice of Config the admin modules read, cast whole — parsing the full schema here would couple these
// tests to every unrelated knob's default.
const configWith = (overrides?: Record<string, unknown>): Config =>
    ({
        admin: { emails: `radarsu@gmail.com` },
        pool: { priceUsd: 20, canaryFailures: 3, stripeSecretKey: `sk`, stripePriceId: `price` },
        hosted: { monthlyHours: 40, poolSize: 2, image: `ghcr.io/intentic/sandbox:stable`, flyApiToken: ``, flyOrg: `` },
        zrok: { adminToken: ``, apiEndpoint: `` },
        trial: { keys: `k1`, dailyMessages: 12 },
        wallet: { custodyUrl: ``, custodyKey: `` },
        apns: { keyP8: `` },
        ...overrides,
    }) as unknown as Config;

const contextWith = (emails: string, user: { email: string } | null): OrpcContext =>
    ({ user: user ? { id: `u1`, email: user.email, name: `x`, image: null } : null, config: { admin: { emails } } }) as OrpcContext;

describe(`requireAdmin`, () => {
    it(`refuses an unauthenticated caller with UNAUTHORIZED, before any allowlist reading`, () => {
        expect(() => requireAdmin(contextWith(`radarsu@gmail.com`, null))).toThrowError(
            expect.objectContaining({ code: `UNAUTHORIZED` }) as unknown as ORPCError<string, unknown>,
        );
    });

    it(`refuses everyone when the allowlist is empty — the unconfigured platform has no admin surface`, () => {
        expect(() => requireAdmin(contextWith(``, { email: `radarsu@gmail.com` }))).toThrowError(
            expect.objectContaining({ code: `FORBIDDEN` }) as unknown as ORPCError<string, unknown>,
        );
    });

    it(`refuses a signed-in account that is not on the list`, () => {
        expect(() => requireAdmin(contextWith(`radarsu@gmail.com`, { email: `visitor@example.com` }))).toThrowError(
            expect.objectContaining({ code: `FORBIDDEN` }) as unknown as ORPCError<string, unknown>,
        );
    });

    it(`admits a listed email and returns the session user`, () => {
        expect(requireAdmin(contextWith(`radarsu@gmail.com`, { email: `radarsu@gmail.com` })).email).toBe(`radarsu@gmail.com`);
    });

    it(`matches by address, not by spelling: case-folded on both sides, whitespace trimmed, several entries`, () => {
        const context = contextWith(` Ops@Example.COM , radarsu@gmail.com `, { email: `RADARSU@gmail.com` });
        expect(requireAdmin(context).email).toBe(`RADARSU@gmail.com`);
    });

    it(`does not admit on a stray empty entry (",," never matches the empty string)`, () => {
        expect(() => requireAdmin(contextWith(`,,`, { email: `visitor@example.com` }))).toThrowError(
            expect.objectContaining({ code: `FORBIDDEN` }) as unknown as ORPCError<string, unknown>,
        );
    });
});

describe(`adminOverview`, () => {
    it(`assembles counts, the membership book, activity windows and lanes — absent group-by rows zero-filled`, async () => {
        // The sandbox mock answers by window: the where's gte names which count is being asked for.
        const windows = new Map([
            [new Date(`2026-08-25T10:25:00Z`).getTime(), 3], // 5 min — connected now
            [new Date(`2026-08-24T10:30:00Z`).getTime(), 4], // 24h
            [new Date(`2026-08-18T10:30:00Z`).getTime(), 5], // 7d
            [new Date(`2026-07-26T10:30:00Z`).getTime(), 6], // 30d
        ]);
        const prisma = {
            user: { count: async () => 7 },
            sandbox: {
                count: async (args?: { where?: { lastSeenAt?: { gte: Date } } }) => {
                    const gte = args?.where?.lastSeenAt?.gte;
                    return gte ? (windows.get(gte.getTime()) ?? -1) : 9;
                },
            },
            membership: {
                groupBy: async () => [
                    { status: `active`, _count: { _all: 2 } },
                    { status: `past_due`, _count: { _all: 1 } },
                ],
                count: async () => 1,
            },
            service: { groupBy: async () => [{ status: `listed`, _count: { _all: 4 } }] },
            serviceRun: { count: async () => 11 },
            hostedMachine: { count: async () => 5 },
        } as unknown as PrismaClient;

        const overview = await adminOverview(prisma, configWith(), () => NOW);
        expect(overview).toEqual({
            users: 7,
            sandboxes: 9,
            activeDaemons: 3,
            activeSandboxes: { day: 4, week: 5, month: 6 },
            memberships: { active: 2, trialing: 0, pastDue: 1, canceled30d: 1, mrrUsd: 40 },
            services: { draft: 0, probation: 0, listed: 4, suspended: 0 },
            runsToday: 11,
            hostedMachines: 5,
            // trial has a key and the pool has Stripe; hosted, wallet and push are unconfigured.
            lanes: { trial: true, pool: true, hosted: false, wallet: false, push: false },
        });
    });
});

describe(`adminFunnel`, () => {
    const prismaWith = (counts: { total: number; withSandbox: number; engaged: number; connected: number; active7: number }, signups: Date[]) =>
        ({
            user: {
                count: async (args?: { where?: Record<string, unknown> }) => {
                    const where = args?.where;
                    if (!where) {
                        return counts.total;
                    }
                    if (where[`createdAt`]) {
                        // Window signup counts answer by how far back the window reaches.
                        const gte = (where[`createdAt`] as { gte: Date }).gte;
                        return signups.filter((at) => at >= gte).length;
                    }
                    const some = (where[`sandboxes`] as { some: Record<string, unknown> }).some;
                    if (some[`OR`]) {
                        return counts.engaged;
                    }
                    if (some[`lastSeenAt`]) {
                        return (some[`lastSeenAt`] as { not?: null }).not === null ? counts.connected : counts.active7;
                    }
                    return counts.withSandbox;
                },
                findMany: async () => signups.map((createdAt) => ({ createdAt })),
            },
        }) as unknown as PrismaClient;

    it(`buckets signups per UTC day, zero-filled to exactly 30 entries oldest-first`, async () => {
        const signups = [new Date(`2026-08-25T09:00:00Z`), new Date(`2026-08-25T01:00:00Z`), new Date(`2026-08-20T23:59:00Z`)];
        const funnel = await adminFunnel(prismaWith({ total: 10, withSandbox: 8, engaged: 6, connected: 4, active7: 2 }, signups), () => NOW);
        expect(funnel.signupSeries).toHaveLength(30);
        expect(funnel.signupSeries[0]).toEqual({ day: `2026-07-27`, count: 0 });
        expect(funnel.signupSeries.at(-1)).toEqual({ day: `2026-08-25`, count: 2 });
        expect(funnel.signupSeries.find((entry) => entry.day === `2026-08-20`)).toEqual({ day: `2026-08-20`, count: 1 });
        expect(funnel.signups).toEqual({ today: 2, last7: 3, last30: 3, total: 10 });
    });

    it(`reports the five stages as distinct-account counts, accounts = the user total`, async () => {
        const funnel = await adminFunnel(prismaWith({ total: 10, withSandbox: 8, engaged: 6, connected: 4, active7: 2 }, []), () => NOW);
        expect(funnel.funnel).toEqual({ accounts: 10, withSandbox: 8, setupEngaged: 6, connected: 4, activeLast7: 2 });
    });
});

describe(`adminAttention`, () => {
    const emptyPrisma = () =>
        ({
            sandbox: { findMany: async () => [] },
            creatorPayout: { findMany: async () => [] },
            creatorStatement: { findMany: async () => [] },
            payoutAccount: { findMany: async () => [] },
            membership: { findMany: async () => [] },
            hostedPoolMachine: { findMany: async () => [] },
            service: { findMany: async () => [] },
        }) as unknown as PrismaClient;

    it(`answers empty and untruncated when nothing needs a human`, async () => {
        expect(await adminAttention(emptyPrisma(), configWith(), () => NOW)).toEqual({ items: [], truncated: false });
    });

    it(`composes sentences server-side, orders danger before warning then newest, and anchors drill-downs`, async () => {
        const prisma = emptyPrisma();
        // A stuck setup WITH a failure (danger), a payout failing (danger), a canary climbing (warning).
        (prisma.sandbox as { findMany: unknown }).findMany = async (args: { where: Record<string, unknown> }) =>
            args.where[`setupCodeClaimedAt`]
                ? [
                      {
                          id: `sb1`,
                          name: `dev box`,
                          setupCodeClaimedAt: new Date(`2026-08-25T08:00:00Z`),
                          setupReport: { stage: `creating-tunnel`, failed: [{ check: `tunnel`, problem: `zrok enable refused`, remedy: `` }], at: `x` },
                          owner: { email: `alice@example.com` },
                      },
                  ]
                : [];
        (prisma.creatorPayout as { findMany: unknown }).findMany = async () => [
            {
                amountCents: 2500,
                attempts: 2,
                lastError: `account requirements past due`,
                createdAt: new Date(`2026-08-24T00:00:00Z`),
                user: { email: `creator@example.com` },
            },
        ];
        (prisma.service as { findMany: unknown }).findMany = async (args: { where: Record<string, unknown> }) =>
            args.where[`canaryFails`] ? [{ slug: `research`, canaryFails: 2, updatedAt: new Date(`2026-08-25T09:00:00Z`) }] : [];

        const attention = await adminAttention(prisma, configWith(), () => NOW);
        expect(attention.truncated).toBe(false);
        expect(attention.items.map((item) => item.kind)).toEqual([`stuck-setup`, `payout-stuck`, `service-canary`]);
        const [stuck, payout, canary] = attention.items;
        expect(stuck).toMatchObject({
            severity: `danger`,
            title: `Setup stuck for alice@example.com (“dev box”)`,
            detail: `tunnel: zrok enable refused`,
            email: `alice@example.com`,
            sandboxId: `sb1`,
        });
        expect(payout).toMatchObject({ severity: `danger`, title: `$25.00 payout to creator@example.com failing (2 attempts)` });
        // The canary sentence quotes the configured suspension threshold, not a constant.
        expect(canary).toMatchObject({ severity: `warning`, detail: `Suspends at 3.`, serviceSlug: `research` });
    });

    it(`says truncated when any category hits its cap, so a bounded feed never reads as complete`, async () => {
        const prisma = emptyPrisma();
        (prisma.membership as { findMany: unknown }).findMany = async () =>
            Array.from({ length: 20 }, (_, index) => ({
                currentPeriodEnd: new Date(`2026-08-01T00:00:00Z`),
                updatedAt: new Date(`2026-08-20T00:00:00Z`),
                user: { email: `user${index}@example.com` },
            }));
        const attention = await adminAttention(prisma, configWith(), () => NOW);
        expect(attention.items).toHaveLength(20);
        expect(attention.truncated).toBe(true);
    });
});

describe(`adminCosts`, () => {
    it(`aggregates the month's hosted spend and the trial week against their config knobs`, async () => {
        const captured: { usageWhere?: unknown; trialWeekWhere?: unknown } = {};
        const prisma = {
            hostedMachine: {
                count: async (args?: { where?: Record<string, unknown> }) => (args?.where?.[`wokeAt`] ? 2 : args?.where?.[`idleWarnedAt`] ? 1 : 6),
            },
            hostedUsage: {
                aggregate: async (args: { where: unknown }) => {
                    captured.usageWhere = args.where;
                    return { _sum: { minutes: 480 } };
                },
                findMany: async () => [
                    { minutes: 300, userId: `u1` },
                    { minutes: 180, userId: `gone` },
                ],
            },
            hostedPoolMachine: {
                findMany: async () => [
                    { region: `iad`, state: `ready`, image: `ghcr.io/intentic/sandbox:stable` },
                    { region: `iad`, state: `building`, image: `ghcr.io/intentic/sandbox:old` },
                    { region: `arn`, state: `claimed`, image: `ghcr.io/intentic/sandbox:stable` },
                ],
            },
            trialUsage: {
                aggregate: async () => ({ _sum: { messages: 9 }, _count: { _all: 4 } }),
                findMany: async (args: { where: unknown }) => {
                    captured.trialWeekWhere = args.where;
                    return [
                        { userId: `u1`, messages: 5, lastModel: `gemini-2.5-flash` },
                        { userId: `u1`, messages: 3, lastModel: `gemini-2.5-pro` },
                        { userId: `u2`, messages: 1, lastModel: `gemini-2.5-flash` },
                        { userId: `u3`, messages: 2, lastModel: null },
                    ];
                },
            },
            user: { findMany: async () => [{ id: `u1`, email: `heavy@example.com` }] },
        } as unknown as PrismaClient;

        const costs = await adminCosts(prisma, configWith(), () => NOW);
        expect(costs.hosted).toEqual({
            machines: 6,
            awakeOrUncounted: 2,
            idleWarned: 1,
            monthMinutes: 480,
            monthlyHoursCap: 40,
            // The unresolvable owner is dropped, never invented: the schema promises real addresses.
            topOwners: [{ email: `heavy@example.com`, minutes: 300 }],
            pool: [
                { region: `arn`, building: 0, ready: 0, claimed: 1, staleImage: 0 },
                { region: `iad`, building: 1, ready: 1, claimed: 0, staleImage: 1 },
            ],
            poolSize: 2,
            image: `ghcr.io/intentic/sandbox:stable`,
        });
        expect(costs.trial).toEqual({
            enabled: true,
            dailyMessages: 12,
            messagesToday: 9,
            usersToday: 4,
            messages7d: 11,
            users7d: 3,
            // Accounts per model, distinct — u1 served by two rungs counts once under each.
            models: [
                { model: `gemini-2.5-flash`, accounts: 2 },
                { model: `gemini-2.5-pro`, accounts: 1 },
            ],
        });
        // The month key and the week's day keys are the same strings the meters bill by.
        expect(captured.usageWhere).toEqual({ month: `2026-08` });
        expect(captured.trialWeekWhere).toEqual({ day: { in: [`2026-08-19`, `2026-08-20`, `2026-08-21`, `2026-08-22`, `2026-08-23`, `2026-08-24`, `2026-08-25`] } });
    });
});

describe(`adminUserDetail`, () => {
    it(`answers null when neither id nor email matches`, async () => {
        const prisma = { user: { findFirst: async () => null } } as unknown as PrismaClient;
        expect(await adminUserDetail(prisma, `nobody@example.com`, () => NOW)).toBeNull();
    });

    it(`assembles the support page: sandboxes with their operational columns, meters, and the creator side`, async () => {
        const captured: { lookup?: unknown } = {};
        const prisma = {
            user: {
                findFirst: async (args: { where: unknown }) => {
                    captured.lookup = args.where;
                    return {
                        id: `u1`,
                        email: `Alice@Example.com`,
                        name: `Alice`,
                        image: null,
                        createdAt: new Date(`2026-08-01T00:00:00Z`),
                        termsVersion: `2026-05`,
                    };
                },
            },
            session: {
                findMany: async () => [
                    { createdAt: new Date(`2026-08-25T09:00:00Z`), expiresAt: new Date(`2026-09-25T09:00:00Z`), ipAddress: `1.2.3.4`, userAgent: `Firefox` },
                ],
            },
            account: { findMany: async () => [{ providerId: `google` }, { providerId: `google` }] },
            membership: { findUnique: async () => ({ status: `active`, currentPeriodEnd: new Date(`2026-09-01T00:00:00Z`) }) },
            creditSpend: { findUnique: async () => ({ credits: 40 }) },
            trialUsage: { findMany: async () => [{ day: `2026-08-25`, messages: 3, lastModel: `gemini-2.5-flash` }] },
            hostedUsage: { findUnique: async () => ({ minutes: 120 }) },
            wallet: { findMany: async () => [{ id: `w1`, network: `eip155:8453`, address: `0xabc`, perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00` }] },
            walletPayment: { count: async () => 4 },
            sandbox: {
                findMany: async () => [
                    {
                        id: `sb1`,
                        name: `dev box`,
                        createdAt: new Date(`2026-08-02T00:00:00Z`),
                        lastSeenAt: null,
                        daemonUrl: null,
                        setupCodeClaimedAt: new Date(`2026-08-02T01:00:00Z`),
                        setupReport: { stage: `pulling-image`, failed: [], at: `x` },
                        bootReport: null,
                        announceRefusal: null,
                        cloud: null,
                        hosted: { region: `arn`, appName: `intentic-sbx-1`, wokeAt: new Date(`2026-08-25T08:00:00Z`), idleWarnedAt: null },
                        members: [{ email: `bob@example.com`, role: `collaborator`, acceptedAt: null }],
                    },
                ],
            },
            sandboxMember: {
                findMany: async () => [
                    { role: `viewer`, acceptedAt: new Date(`2026-08-10T00:00:00Z`), sandbox: { name: `team box`, owner: { email: `boss@example.com` } } },
                ],
            },
            publisherClaim: { findMany: async () => [{ publisher: `alice` }] },
            service: { findMany: async () => [] },
            creatorPayout: { findMany: async () => [] },
        } as unknown as PrismaClient;

        const detail = await adminUserDetail(prisma, ` alice@example.COM `, () => NOW);
        // The lookup tried both identities, email case-insensitively, needle trimmed.
        expect(captured.lookup).toEqual({
            OR: [{ id: `alice@example.COM` }, { email: { equals: `alice@example.COM`, mode: `insensitive` } }],
        });
        expect(detail?.user).toMatchObject({ id: `u1`, email: `Alice@Example.com`, termsVersion: `2026-05` });
        expect(detail?.providers).toEqual([`google`]);
        expect(detail?.membership).toEqual({ status: `active`, currentPeriodEnd: `2026-09-01T00:00:00.000Z` });
        expect(detail?.creditsToday).toBe(40);
        expect(detail?.hostedMonthMinutes).toBe(120);
        expect(detail?.wallets).toEqual([{ network: `eip155:8453`, address: `0xabc`, perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00`, payments30d: 4 }]);
        expect(detail?.sandboxes[0]).toMatchObject({
            id: `sb1`,
            setupClaimedAt: `2026-08-02T01:00:00.000Z`,
            setupReport: { stage: `pulling-image` },
            hosted: { region: `arn`, wokeAt: `2026-08-25T08:00:00.000Z`, idleWarnedAt: null },
            members: [{ email: `bob@example.com`, role: `collaborator`, accepted: false }],
        });
        expect(detail?.memberOf).toEqual([{ sandboxName: `team box`, ownerEmail: `boss@example.com`, role: `viewer`, accepted: true }]);
        // A publisher claim alone makes the account a creator, even with no listing and no payout yet.
        expect(detail?.creator).toEqual({ publishers: [`alice`], services: [], payouts: [] });
    });
});

describe(`adminUsers`, () => {
    const row = (id: string, extra?: { membership?: { status: string } | null; sandboxes?: number }) => ({
        id,
        email: `${id}@example.com`,
        name: `User ${id}`,
        image: null,
        createdAt: new Date(`2026-08-01T00:00:00Z`),
        membership: extra?.membership ?? null,
        _count: { sandboxes: extra?.sandboxes ?? 0 },
    });

    const prismaWith = (rows: ReturnType<typeof row>[], total: number, captured: { findArgs?: Record<string, unknown>; countArgs?: unknown }) =>
        ({
            user: {
                findMany: async (args: Record<string, unknown>) => {
                    captured.findArgs = args;
                    return rows;
                },
                count: async (args: unknown) => {
                    captured.countArgs = args;
                    return total;
                },
            },
        }) as unknown as PrismaClient;

    it(`maps rows to the wire shape: ISO createdAt, sandbox count, membership status only when one exists`, async () => {
        const captured: { findArgs?: Record<string, unknown> } = {};
        const prisma = prismaWith([row(`a`, { membership: { status: `active` }, sandboxes: 2 }), row(`b`)], 2, captured);
        const result = await adminUsers(prisma, { limit: 50 });
        expect(result).toEqual({
            total: 2,
            users: [
                {
                    id: `a`,
                    email: `a@example.com`,
                    name: `User a`,
                    image: null,
                    createdAt: `2026-08-01T00:00:00.000Z`,
                    sandboxCount: 2,
                    membershipStatus: `active`,
                },
                { id: `b`, email: `b@example.com`, name: `User b`, image: null, createdAt: `2026-08-01T00:00:00.000Z`, sandboxCount: 0 },
            ],
        });
        // No overflow row came back, so there is no next page and no cursor.
        expect(result.nextCursor).toBeUndefined();
    });

    it(`pages by one-row overflow: limit rows returned, nextCursor names the last RENDERED row`, async () => {
        const captured = {};
        const prisma = prismaWith([row(`a`), row(`b`), row(`c`)], 10, captured);
        const result = await adminUsers(prisma, { limit: 2 });
        expect(result.users.map((user) => user.id)).toEqual([`a`, `b`]);
        expect(result.nextCursor).toBe(`b`);
    });

    it(`passes the cursor through as an exclusive boundary (skip 1) and asks for limit+1 rows`, async () => {
        const captured: { findArgs?: Record<string, unknown> } = {};
        await adminUsers(prismaWith([], 0, captured), { limit: 2, cursor: `b` });
        expect(captured.findArgs).toMatchObject({ take: 3, cursor: { id: `b` }, skip: 1 });
    });

    it(`filters email OR name case-insensitively, and the SAME filter feeds the total`, async () => {
        const captured: { findArgs?: Record<string, unknown>; countArgs?: unknown } = {};
        await adminUsers(prismaWith([], 0, captured), { limit: 50, query: `  Radarsu ` });
        const where = {
            OR: [
                { email: { contains: `Radarsu`, mode: `insensitive` } },
                { name: { contains: `Radarsu`, mode: `insensitive` } },
            ],
        };
        expect(captured.findArgs?.[`where`]).toEqual(where);
        expect(captured.countArgs).toEqual({ where });
    });
});

/* THE WIRE, NOT JUST THE FUNCTIONS. The panel is a plain `fetch` against the OpenAPI surface — a GET whose
 * input arrives as query-string strings — so what is worth pinning here is the whole path through the same
 * OpenAPIHandler app.ts mounts: query params parsed and coerced into the contract input, the guard answering
 * 403 as an HTTP status, and the audit line written with the caller's email. */
describe(`admin over the OpenAPI wire`, () => {
    const logLines: unknown[] = [];
    const logger = { info: (fields: unknown) => logLines.push(fields), warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

    const serve = async (url: string, user: { email: string } | null, prisma: PrismaClient) => {
        const handler = new OpenAPIHandler({ admin: adminRoutes });
        const context = {
            prisma,
            config: { admin: { emails: `radarsu@gmail.com` } },
            user: user ? { id: `u1`, email: user.email, name: `x`, image: null } : null,
            logger,
        } as unknown as OrpcContext;
        const result = await handler.handle(new Request(`http://api.test${url}`), { context, prefix: `/rpc` });
        if (!result.matched) {
            throw new Error(`route did not match`);
        }
        return result.response;
    };

    it(`parses ?limit=&query= off the query string, coerces limit, and answers the page as JSON`, async () => {
        let findArgs: Record<string, unknown> | undefined;
        const prisma = {
            user: {
                findMany: async (args: Record<string, unknown>) => {
                    findArgs = args;
                    return [];
                },
                count: async () => 0,
            },
        } as unknown as PrismaClient;
        const response = await serve(`/rpc/admin/users?limit=2&query=radar`, { email: `radarsu@gmail.com` }, prisma);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ users: [], total: 0 });
        // limit=2 arrived as a string and reached the query as the number 3 (limit + the overflow row).
        expect(findArgs).toMatchObject({ take: 3 });
        // The audit line names who asked for what.
        expect(logLines).toContainEqual({ admin: `radarsu@gmail.com`, route: `admin.users` });
    });

    it(`answers 404 for an unknown account on /admin/user, and 400 when idOrEmail is missing`, async () => {
        const prisma = { user: { findFirst: async () => null } } as unknown as PrismaClient;
        expect((await serve(`/rpc/admin/user?idOrEmail=nobody`, { email: `radarsu@gmail.com` }, prisma)).status).toBe(404);
        expect((await serve(`/rpc/admin/user`, { email: `radarsu@gmail.com` }, prisma)).status).toBe(400);
    });

    it(`answers 403 to a signed-in non-admin and 401 to no session, as HTTP statuses the panel reads`, async () => {
        const prisma = {} as PrismaClient;
        expect((await serve(`/rpc/admin/overview`, { email: `visitor@example.com` }, prisma)).status).toBe(403);
        expect((await serve(`/rpc/admin/overview`, null, prisma)).status).toBe(401);
    });
});
