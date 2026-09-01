import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { requireAdmin } from "../guards.js";
import { retryPayout } from "../pool/pool-payout.js";
import { deleteUserAccount, reinstateService, stopHostedMachine, suspendService } from "./admin-actions.js";
import { adminAttention } from "./admin-attention.js";
import { adminCosts } from "./admin-costs.js";
import { sendAdminDigest } from "./admin-digest.js";
import { adminFunnel } from "./admin-funnel.js";
import { adminMarket } from "./admin-market.js";
import { adminOverview } from "./admin-overview.js";
import { adminRoutes } from "./admin.routes.js";
import { rollupAdminDaily } from "./admin-rollup.js";
import { adminTrends } from "./admin-trends.js";
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
        admin: { emails: `radarsu@gmail.com`, mutations: false },
        pool: {
            priceUsd: 20,
            canaryFailures: 3,
            stripeSecretKey: `sk`,
            stripePriceId: `price`,
            graduationRuns: 50,
            watchWindowRuns: 20,
            maxRefundRate: 0.2,
        },
        hosted: { monthlyHours: 40, poolSize: 2, image: `ghcr.io/intentic/sandbox:stable`, flyApiToken: ``, flyOrg: `` },
        ingress: { url: ``, signingKey: ``, zone: `sbx.test` },
        trial: { keys: `k1`, dailyMessages: 12 },
        wallet: { custodyUrl: ``, custodyKey: `` },
        apns: { keyP8: `` },
        email: { apiKey: ``, from: `` },
        webOrigin: `https://app.test`,
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
            mutationsEnabled: false,
        });
    });
});

describe(`adminFunnel`, () => {
    const prismaWith = (
        counts: { total: number; withSandbox: number; engaged: number; connected: number; active7: number },
        signups: Date[],
        activated: { ownerId: string; firstAnnouncedAt: Date; owner: { createdAt: Date } }[] = [],
        veterans: { ownerId: string }[] = [],
    ) =>
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
            sandbox: {
                // First call asks for the window's activations, second probes for pre-window veterans.
                findMany: async (args: { where: Record<string, unknown> }) =>
                    (args.where[`firstAnnouncedAt`] as { gte?: Date }).gte ? activated : veterans,
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
        // Nobody activated in the window: the honest answer is null, never zero hours.
        expect(funnel.activation).toBeNull();
    });

    it(`medians sign-up → first announce per owner, excluding owners who had activated before the window`, async () => {
        const counts = { total: 10, withSandbox: 8, engaged: 6, connected: 4, active7: 2 };
        const activated = [
            // Alice: signed up at 00:00, first announce 2h later; a second sandbox later must not count.
            { ownerId: `alice`, firstAnnouncedAt: new Date(`2026-08-20T02:00:00Z`), owner: { createdAt: new Date(`2026-08-20T00:00:00Z`) } },
            { ownerId: `alice`, firstAnnouncedAt: new Date(`2026-08-22T00:00:00Z`), owner: { createdAt: new Date(`2026-08-20T00:00:00Z`) } },
            // Bob: 10h to activate.
            { ownerId: `bob`, firstAnnouncedAt: new Date(`2026-08-21T10:00:00Z`), owner: { createdAt: new Date(`2026-08-21T00:00:00Z`) } },
            // Carol activated a sandbox this window but was already active before it: not a first activation.
            { ownerId: `carol`, firstAnnouncedAt: new Date(`2026-08-22T01:00:00Z`), owner: { createdAt: new Date(`2026-01-01T00:00:00Z`) } },
        ];
        const funnel = await adminFunnel(prismaWith(counts, [], activated, [{ ownerId: `carol` }]), () => NOW);
        // Alice 2h, Bob 10h → median 6h over 2 accounts.
        expect(funnel.activation).toEqual({ medianHours: 6, count: 2 });
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
                          setupReport: {
                              stage: `creating-tunnel`,
                              failed: [{ check: `tunnel`, problem: `the ingress refused the grant`, remedy: `` }],
                              at: `x`,
                          },
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
            detail: `tunnel: the ingress refused the grant`,
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
        expect(captured.trialWeekWhere).toEqual({
            day: { in: [`2026-08-19`, `2026-08-20`, `2026-08-21`, `2026-08-22`, `2026-08-23`, `2026-08-24`, `2026-08-25`] },
        });
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
                    {
                        createdAt: new Date(`2026-08-25T09:00:00Z`),
                        expiresAt: new Date(`2026-09-25T09:00:00Z`),
                        ipAddress: `1.2.3.4`,
                        userAgent: `Firefox`,
                    },
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
                        hosted: { region: `arn`, appName: `intentic-sbx-1`, wokeAt: new Date(`2026-08-25T08:00:00Z`), idleWarnedAt: null },
                        members: [{ email: `bob@example.com`, role: `collaborator`, acceptedAt: null }],
                    },
                ],
            },
            sandboxMember: {
                findMany: async () => [
                    {
                        role: `viewer`,
                        acceptedAt: new Date(`2026-08-10T00:00:00Z`),
                        sandbox: { name: `team box`, owner: { email: `boss@example.com` } },
                    },
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
        expect(detail?.wallets).toEqual([
            { network: `eip155:8453`, address: `0xabc`, perPaymentMaxUsd: `1.00`, dailyCapUsd: `5.00`, payments30d: 4 },
        ]);
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
            OR: [{ email: { contains: `Radarsu`, mode: `insensitive` } }, { name: { contains: `Radarsu`, mode: `insensitive` } }],
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

    const serve = async (url: string, user: { email: string } | null, prisma: PrismaClient, options?: { mutations?: boolean; body?: unknown }) => {
        const handler = new OpenAPIHandler({ admin: adminRoutes });
        const context = {
            prisma,
            config: { admin: { emails: `radarsu@gmail.com`, mutations: options?.mutations ?? false } },
            user: user ? { id: `u1`, email: user.email, name: `x`, image: null } : null,
            logger,
        } as unknown as OrpcContext;
        const request = options?.body
            ? new Request(`http://api.test${url}`, {
                  method: `POST`,
                  headers: { "content-type": `application/json` },
                  body: JSON.stringify(options.body),
              })
            : new Request(`http://api.test${url}`);
        const result = await handler.handle(request, { context, prefix: `/rpc` });
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

    it(`refuses every mutation while ADMIN_MUTATIONS is off, even for a verified admin`, async () => {
        const prisma = {} as PrismaClient;
        const response = await serve(`/rpc/admin/service/suspend`, { email: `radarsu@gmail.com` }, prisma, {
            body: { slug: `research`, reason: `x`, confirm: `research` },
        });
        expect(response.status).toBe(403);
        expect(((await response.json()) as { message: string }).message).toContain(`ADMIN_MUTATIONS`);
    });

    it(`a mistyped confirmation is a 400 before anything is touched; a correct one flips the row`, async () => {
        let touched = false;
        const prisma = {
            service: {
                findUnique: async () => ({ status: `listed` }),
                update: async () => {
                    touched = true;
                    return {};
                },
            },
        } as unknown as PrismaClient;
        const wrong = await serve(`/rpc/admin/service/suspend`, { email: `radarsu@gmail.com` }, prisma, {
            mutations: true,
            body: { slug: `research`, reason: `bad actor`, confirm: `reserach` },
        });
        expect(wrong.status).toBe(400);
        expect(touched).toBe(false);
        const right = await serve(`/rpc/admin/service/suspend`, { email: `radarsu@gmail.com` }, prisma, {
            mutations: true,
            body: { slug: `research`, reason: `bad actor`, confirm: `research` },
        });
        expect(right.status).toBe(200);
        expect(((await right.json()) as { ok: boolean }).ok).toBe(true);
        expect(touched).toBe(true);
    });

    it(`erasure demands the account's email retyped and refuses the admin's own account`, async () => {
        const prisma = {
            user: { findUnique: async () => ({ id: `u2`, email: `victim@example.com` }) },
        } as unknown as PrismaClient;
        const mismatch = await serve(`/rpc/admin/user/delete`, { email: `radarsu@gmail.com` }, prisma, {
            mutations: true,
            body: { userId: `u2`, confirmEmail: `wrong@example.com` },
        });
        expect(mismatch.status).toBe(400);
        const self = {
            user: { findUnique: async () => ({ id: `u1`, email: `radarsu@gmail.com` }) },
        } as unknown as PrismaClient;
        const own = await serve(`/rpc/admin/user/delete`, { email: `radarsu@gmail.com` }, self, {
            mutations: true,
            body: { userId: `u1`, confirmEmail: `radarsu@gmail.com` },
        });
        expect(own.status).toBe(400);
        expect(((await mismatch.json()) as { message: string }).message).not.toBe(((await own.json()) as { message: string }).message);
    });
});

describe(`adminMarket`, () => {
    it(`reduces wants to distinct owners with the newest phrasing, and joins each listing to its counters`, async () => {
        const prisma = {
            serviceWant: {
                findMany: async () => [
                    { userId: `u1`, text: `pdf OCR`, normalized: `pdf ocr`, createdAt: new Date(`2026-08-01T00:00:00Z`) },
                    { userId: `u2`, text: `PDF ocr`, normalized: `pdf ocr`, createdAt: new Date(`2026-08-02T00:00:00Z`) },
                    { userId: `u1`, text: `pdf ocr please`, normalized: `pdf ocr please`, createdAt: new Date(`2026-08-03T00:00:00Z`) },
                ],
            },
            service: {
                findMany: async () => [
                    {
                        id: `s1`,
                        slug: `research`,
                        publisher: `acme`,
                        name: `Research`,
                        status: `probation`,
                        creditsPerRun: 10,
                        userId: `owner1`,
                        canaryFails: 1,
                        probedAt: new Date(`2026-08-24T00:00:00Z`),
                        suspendedFor: null,
                    },
                    {
                        id: `s2`,
                        slug: `demo`,
                        publisher: `intentic`,
                        name: `Demo`,
                        status: `listed`,
                        creditsPerRun: 1,
                        userId: null,
                        canaryFails: 0,
                        probedAt: null,
                        suspendedFor: null,
                    },
                ],
            },
            serviceRun: {
                groupBy: async (args: { by: string[] }) =>
                    args.by.length === 1
                        ? [{ serviceId: `s1`, _count: { _all: 42 } }]
                        : [
                              { serviceId: `s1`, status: `ok`, _count: { _all: 8 } },
                              { serviceId: `s1`, status: `refunded`, _count: { _all: 2 } },
                          ],
            },
            publisherClaim: { count: async () => 3 },
            payoutAccount: { count: async () => 2 },
            creatorPayout: { aggregate: async () => ({ _sum: { amountCents: 2500 } }) },
            creatorStatement: { aggregate: async () => ({ _sum: { amountCents: 9000 } }) },
        } as unknown as PrismaClient;

        const market = await adminMarket(prisma, configWith(), () => NOW);
        // Two owners beat recency; the two-owner ask shows its newest phrasing.
        expect(market.wants).toEqual([
            { text: `PDF ocr`, owners: 2, lastAt: `2026-08-02T00:00:00.000Z` },
            { text: `pdf ocr please`, owners: 1, lastAt: `2026-08-03T00:00:00.000Z` },
        ]);
        expect(market.services[0]).toEqual({
            slug: `research`,
            publisher: `acme`,
            name: `Research`,
            status: `probation`,
            creditsPerRun: 10,
            owned: true,
            servedRuns: 42,
            runs7d: 10,
            refunds7d: 2,
            canaryFails: 1,
            probedAt: `2026-08-24T00:00:00.000Z`,
            suspendedFor: null,
        });
        // The operator row: no owner, no counters, and `owned: false` says the gates don't apply.
        expect(market.services[1]).toMatchObject({ slug: `demo`, owned: false, servedRuns: 0, runs7d: 0 });
        expect(market.thresholds).toEqual({ graduationRuns: 50, watchWindowRuns: 20, maxRefundRate: 0.2, canaryFailures: 3 });
        expect(market.creators).toEqual({ publishers: 3, payoutEnabled: 2, pendingPayoutCents: 2500, unclaimedCents: 9000 });
    });
});

describe(`rollupAdminDaily`, () => {
    const prismaWith = (existing: boolean, captured: { windows: unknown[]; upsert?: Record<string, unknown> }) =>
        ({
            user: {
                count: async (args?: { where?: unknown }) => {
                    if (args?.where) {
                        captured.windows.push(args.where);
                    }
                    return args?.where ? 4 : 100;
                },
            },
            serviceRun: { count: async () => 7 },
            trialUsage: { aggregate: async () => ({ _sum: { messages: 33 } }) },
            sandbox: { count: async () => 12 },
            membership: { count: async () => 5 },
            hostedMachine: { count: async () => 6 },
            adminDailyStat: {
                findUnique: async () => (existing ? { id: `row` } : null),
                upsert: async (args: Record<string, unknown>) => {
                    captured.upsert = args;
                    return {};
                },
            },
        }) as unknown as PrismaClient;

    it(`freezes YESTERDAY under its UTC day key and reports the day's first run as created`, async () => {
        const captured: { windows: unknown[]; upsert?: Record<string, unknown> } = { windows: [] };
        const rollup = await rollupAdminDaily(prismaWith(false, captured), () => NOW);
        expect(rollup).toEqual({ day: `2026-08-24`, created: true });
        // The window is exactly yesterday's UTC day, half-open.
        expect(captured.windows[0]).toMatchObject({
            createdAt: { gte: new Date(`2026-08-24T00:00:00Z`), lt: new Date(`2026-08-25T00:00:00Z`) },
        });
        expect(captured.upsert).toMatchObject({
            where: { day: `2026-08-24` },
            create: { day: `2026-08-24`, newUsers: 4, serviceRuns: 7, trialMessages: 33, totalUsers: 100, membershipsActive: 5 },
        });
    });

    it(`re-runs as an update, not a second row, and says created: false`, async () => {
        const captured: { windows: unknown[] } = { windows: [] };
        expect((await rollupAdminDaily(prismaWith(true, captured), () => NOW)).created).toBe(false);
    });
});

describe(`adminTrends`, () => {
    it(`serves the newest 90 rows oldest-first, so a chart draws left to right`, async () => {
        const prisma = {
            adminDailyStat: {
                findMany: async (args: { take: number }) => {
                    expect(args.take).toBe(90);
                    return [
                        { day: `2026-08-24`, newUsers: 2 },
                        { day: `2026-08-23`, newUsers: 1 },
                    ];
                },
            },
        } as unknown as PrismaClient;
        const trends = await adminTrends(prisma);
        expect(trends.days.map((row) => row.day)).toEqual([`2026-08-23`, `2026-08-24`]);
    });
});

describe(`sendAdminDigest`, () => {
    const logged: { info: { fields?: Record<string, unknown>; message?: string }[]; warn: { fields?: Record<string, unknown>; message?: string }[] } = {
        info: [],
        warn: [],
    };
    const logger = {
        info: (fields: unknown, message?: string) =>
            logged.info.push(typeof fields === `object` && fields !== null && message !== undefined ? { fields: fields as Record<string, unknown>, message } : { message: String(fields) }),
        warn: (fields: unknown, message?: string) =>
            logged.warn.push(typeof fields === `object` && fields !== null && message !== undefined ? { fields: fields as Record<string, unknown>, message } : { message: String(fields) }),
        error: () => {},
        debug: () => {},
    } as unknown as Logger;

    const attentionPrisma = (latchWins: boolean, pastDue: number) =>
        ({
            adminDailyStat: { updateMany: async () => ({ count: latchWins ? 1 : 0 }) },
            sandbox: { findMany: async () => [] },
            creatorPayout: { findMany: async () => [] },
            creatorStatement: { findMany: async () => [] },
            payoutAccount: { findMany: async () => [] },
            membership: {
                findMany: async () =>
                    Array.from({ length: pastDue }, (_, index) => ({
                        currentPeriodEnd: new Date(`2026-08-01T00:00:00Z`),
                        updatedAt: new Date(`2026-08-20T00:00:00Z`),
                        user: { email: `user${index}@example.com` },
                    })),
            },
            hostedPoolMachine: { findMany: async () => [] },
            service: { findMany: async () => [] },
        }) as unknown as PrismaClient;

    it(`sends once per day: the latch losing means somebody else already sent`, async () => {
        logged.info.length = 0;
        await sendAdminDigest(attentionPrisma(false, 3), configWith(), logger, `2026-08-24`, () => NOW);
        expect(logged.info.some((entry) => entry.fields?.[`items`] !== undefined)).toBe(false);
    });

    it(`an empty feed mails nobody — the digest only exists when something needs a human`, async () => {
        logged.info.length = 0;
        await sendAdminDigest(attentionPrisma(true, 0), configWith(), logger, `2026-08-24`, () => NOW);
        expect(logged.info.some((entry) => entry.fields?.[`items`] !== undefined)).toBe(false);
    });

    it(`with items and the latch won it goes to every admin (unconfigured mailer logs the decline, still counted sent)`, async () => {
        logged.info.length = 0;
        logged.warn.length = 0;
        await sendAdminDigest(
            attentionPrisma(true, 2),
            configWith({ admin: { emails: `radarsu@gmail.com, ops@example.com`, mutations: false } }),
            logger,
            `2026-08-24`,
            () => NOW,
        );
        expect(logged.info.some((entry) => entry.fields?.[`items`] === 2 && entry.fields?.[`admins`] === 2)).toBe(true);
        // The unconfigured mailer declined twice — once per admin — instead of throwing.
        expect(logged.warn.filter((entry) => entry.message === `email unconfigured, logging link instead of sending`)).toHaveLength(2);
    });
});

describe(`admin actions`, () => {
    it(`suspend records the operator's reason where the provider reads it; an already-suspended row refuses`, async () => {
        let update: Record<string, unknown> | undefined;
        const prisma = {
            service: {
                findUnique: async () => ({ status: `listed` }),
                update: async (args: Record<string, unknown>) => {
                    update = args;
                    return {};
                },
            },
        } as unknown as PrismaClient;
        const result = await suspendService(prisma, `research`, `provider asked us to pause it`);
        expect(result.ok).toBe(true);
        expect(update).toMatchObject({
            where: { slug: `research` },
            data: { status: `suspended`, suspendedFor: `Suspended by the operator: provider asked us to pause it` },
        });
        const already = { service: { findUnique: async () => ({ status: `suspended` }) } } as unknown as PrismaClient;
        expect((await suspendService(already, `research`, `x`)).ok).toBe(false);
    });

    it(`reinstate goes to probation with a clean canary, and refuses anything not suspended`, async () => {
        let update: Record<string, unknown> | undefined;
        const prisma = {
            service: {
                findUnique: async () => ({ status: `suspended` }),
                update: async (args: Record<string, unknown>) => {
                    update = args;
                    return {};
                },
            },
        } as unknown as PrismaClient;
        expect((await reinstateService(prisma, `research`)).ok).toBe(true);
        expect(update).toMatchObject({ data: { status: `probation`, suspendedFor: null, canaryFails: 0 } });
        const listed = { service: { findUnique: async () => ({ status: `listed` }) } } as unknown as PrismaClient;
        expect((await reinstateService(listed, `research`)).ok).toBe(false);
    });

    it(`machine stop refuses cleanly when the hosted lane is off, and when the sandbox has no machine`, async () => {
        expect((await stopHostedMachine({} as PrismaClient, configWith(), `sb1`)).ok).toBe(false);
        const hostedOn = configWith({
            hosted: { monthlyHours: 40, poolSize: 2, image: `x`, flyApiToken: `t`, flyOrg: `o` },
            ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
        });
        const prisma = { hostedMachine: { findUnique: async () => null } } as unknown as PrismaClient;
        const result = await stopHostedMachine(prisma, hostedOn, `sb1`);
        expect(result.ok).toBe(false);
        expect(result.message).toContain(`sb1`);
    });

    it(`erasure deletes the user row and reports the address it erased (no hosted: nothing external)`, async () => {
        let deleted: Record<string, unknown> | undefined;
        const prisma = {
            sandbox: { findMany: async () => [{ id: `sb1`, hosted: null }] },
            user: {
                delete: async (args: Record<string, unknown>) => {
                    deleted = args;
                    return { email: `gone@example.com` };
                },
            },
        } as unknown as PrismaClient;
        const result = await deleteUserAccount(prisma, configWith(), logger, `u1`);
        expect(result.ok).toBe(true);
        expect(result.message).toContain(`gone@example.com`);
        expect(deleted).toMatchObject({ where: { id: `u1` } });
    });

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
});

describe(`retryPayout`, () => {
    const deps = (payout: Record<string, unknown> | null, account: Record<string, unknown> | null, transfer?: () => Promise<{ id: string }>) =>
        ({
            prisma: {
                creatorPayout: {
                    findUnique: async () => payout,
                    update: async () => ({}),
                },
                payoutAccount: { findUnique: async () => account },
            },
            config: configWith(),
            gateway: { transfer: transfer ?? (async () => ({ id: `tr_1` })) },
        }) as unknown as Parameters<typeof retryPayout>[0];

    it(`refuses an unknown id and a payout that is not pending, in sentences`, async () => {
        const missing = await retryPayout(deps(null, null), `p1`);
        const wrongStatus = await retryPayout(deps({ id: `p1`, userId: `u1`, amountCents: 2500, currency: `usd`, status: `paid` }, null), `p1`);
        expect(missing.paid).toBe(false);
        expect(wrongStatus.paid).toBe(false);
        expect(missing.message).not.toBe(wrongStatus.message);
        expect(wrongStatus.message).toContain(`paid`);
    });

    it(`pays a pending payout through the shared settle path under its own idempotency key`, async () => {
        const result = await retryPayout(
            deps(
                { id: `p1`, userId: `u1`, amountCents: 2500, currency: `usd`, status: `pending` },
                { stripeAccountId: `acct`, payoutsEnabled: true },
                undefined,
            ),
            `p1`,
        );
        expect(result).toEqual({ paid: true, message: `Paid: $25.00 transferred.` });
    });

    it(`a transfer that fails again stays pending and says so`, async () => {
        const result = await retryPayout(
            deps(
                { id: `p1`, userId: `u1`, amountCents: 2500, currency: `usd`, status: `pending` },
                { stripeAccountId: `acct`, payoutsEnabled: true },
                async () => {
                    throw new Error(`account requirements past due`);
                },
            ),
            `p1`,
        );
        expect(result.paid).toBe(false);
        expect(result.message).toContain(`account requirements past due`);
    });
});
