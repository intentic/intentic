import { call, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import type { StripeGateway } from "../pool/pool-stripe.js";
import { CLAIM_PATH, checkClaim, claimToken, registryReader, type RegistryReader } from "./creator-claim.js";
import { creatorRoutes } from "./creator.orpc.js";

/* WHAT A CREATOR WOULD CALL THEFT IF IT DRIFTED. Phase one owns exactly two promises — a publisher name is
 * yours only if you proved it, and money only moves somewhere you connected — so what is pinned here is the
 * refusals, not the happy path alone: an unproved claim failing, another account's name staying theirs, a
 * token that cannot verify a different user's claim, and payout readiness never being invented locally. */

const user = { id: `u1`, email: `creator@example.com`, name: `Creator`, image: null };

const baseConfig = {
    webOrigin: `https://app.test`,
    betterAuth: { secret: `signing-secret` },
    pool: {
        stripeSecretKey: `sk_test`,
        stripeWebhookSecret: `whsec_test`,
        stripePriceId: `price_1`,
        registryUrl: `https://registry.test/marketplace.json`,
    },
} as unknown as Config;

// A pool that is off: no key, no price — the self-hosted default.
const poolOffConfig = { ...baseConfig, pool: { ...baseConfig.pool, stripeSecretKey: ``, stripePriceId: `` } } as Config;

// Each test overrides just the calls its route makes; the two the status read always performs default to empty
// so a test about payout readiness does not have to describe a ledger it is not exercising.
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>>) =>
    ({
        creatorStatement: { findMany: vi.fn().mockResolvedValue([]) },
        creatorPayout: { findMany: vi.fn().mockResolvedValue([]) },
        ...overrides,
    }) as unknown as OrpcContext[`prisma`];

const context = (overrides?: Partial<OrpcContext>): OrpcContext =>
    ({
        prisma: fakePrisma({}),
        config: baseConfig,
        user,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        ...overrides,
    }) as OrpcContext;

const reader = (repos: readonly string[]): RegistryReader => ({ reposOf: vi.fn(async () => repos) });

const expectOrpcCode = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(code);
};

// A fetch that serves one repo's claim file and 404s everything else — the shape a real claim has, where the
// misses outnumber the hit.
const servingFetch = (served: Record<string, string>): typeof fetch =>
    vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = served[url];
        return body === undefined ? new Response(`not found`, { status: 404 }) : new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

const rawUrl = (repo: string) => `https://raw.githubusercontent.com/${repo}/HEAD/${CLAIM_PATH}`;

describe(`publisher claims`, () => {
    it(`accepts a claim only when a repository the registry lists carries THIS user's token`, async () => {
        const token = claimToken(baseConfig, user.id, `acme`);
        const fetchFn = servingFetch({ [rawUrl(`acme/second`)]: `${token}\n` });

        const proof = await checkClaim(baseConfig, reader([`acme/first`, `acme/second`]), user.id, `acme`, fetchFn);

        // Found on the second repo: every listing is tried, so a creator never has to guess which one is read.
        expect(proof).toEqual({ repo: `acme/second` });
    });

    it(`refuses a token minted for a different account or a different publisher`, async () => {
        const otherUsers = claimToken(baseConfig, `u2`, `acme`);
        const otherName = claimToken(baseConfig, user.id, `other`);

        expect(
            await checkClaim(baseConfig, reader([`acme/first`]), user.id, `acme`, servingFetch({ [rawUrl(`acme/first`)]: otherUsers })),
        ).toBeUndefined();
        expect(
            await checkClaim(baseConfig, reader([`acme/first`]), user.id, `acme`, servingFetch({ [rawUrl(`acme/first`)]: otherName })),
        ).toBeUndefined();
    });

    it(`survives a repository that errors, and refuses when the publisher has no listed repositories`, async () => {
        const token = claimToken(baseConfig, user.id, `acme`);
        const flaky = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === rawUrl(`acme/dead`)) {
                throw new Error(`connection refused`);
            }
            return new Response(token, { status: 200 });
        }) as unknown as typeof fetch;

        expect(await checkClaim(baseConfig, reader([`acme/dead`, `acme/live`]), user.id, `acme`, flaky)).toEqual({ repo: `acme/live` });
        expect(await checkClaim(baseConfig, reader([]), user.id, `acme`, flaky)).toBeUndefined();
    });

    it(`reads the registry for github-sourced listings under the publisher, and caches the file`, async () => {
        const marketplace = {
            plugins: [
                { name: `acme.one`, source: { source: `github`, repo: `acme/one` } },
                { name: `acme.two`, source: { source: `github`, repo: `acme/two` } },
                // Same repo twice must not become two attempts.
                { name: `acme.three`, source: { source: `github`, repo: `acme/one` } },
                // Not verifiable this way, and must not break the read for the ones that are.
                { name: `acme.four`, source: { source: `url`, url: `https://git.test/x.git` } },
                { name: `other.one`, source: { source: `github`, repo: `other/one` } },
            ],
        };
        const fetchFn = vi.fn(async () => new Response(JSON.stringify(marketplace), { status: 200 })) as unknown as typeof fetch;
        const at = new Date(`2026-08-12T10:00:00Z`);
        const registry = registryReader(baseConfig, fetchFn, () => at);

        expect(await registry.reposOf(`acme`)).toEqual([`acme/one`, `acme/two`]);
        expect(await registry.reposOf(`other`)).toEqual([`other/one`]);
        // Second read inside the window is served from cache — a claim screen must not re-fetch per visit.
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it(`does not cache a failed registry read`, async () => {
        const fetchFn = vi.fn(async () => new Response(`nope`, { status: 500 })) as unknown as typeof fetch;
        const registry = registryReader(baseConfig, fetchFn, () => new Date(`2026-08-12T10:00:00Z`));

        await expect(registry.reposOf(`acme`)).rejects.toThrow();
        await expect(registry.reposOf(`acme`)).rejects.toThrow();
        // An outage must not pin an empty answer in front of every claimant for the cache window.
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });
});

describe(`creator routes`, () => {
    it(`claim records the repository that proved it`, async () => {
        const token = claimToken(baseConfig, user.id, `acme`);
        const create = vi.fn().mockResolvedValue({ publisher: `acme`, repo: `acme/one`, createdAt: new Date(`2026-08-12T10:00:00Z`) });
        const prisma = fakePrisma({ publisherClaim: { findUnique: vi.fn().mockResolvedValue(null), create } });
        const routes = creatorRoutes({ reader: reader([`acme/one`]), fetchFn: servingFetch({ [rawUrl(`acme/one`)]: token }) });

        const result = await call(routes.claim, { publisher: `acme` }, { context: context({ prisma }) });

        expect(create).toHaveBeenCalledWith({ data: { publisher: `acme`, userId: `u1`, repo: `acme/one` } });
        expect(result).toEqual({ publisher: `acme`, repo: `acme/one`, claimedAt: `2026-08-12T10:00:00.000Z` });
    });

    it(`refuses a claim with no readable proof, and writes nothing`, async () => {
        const create = vi.fn();
        const prisma = fakePrisma({ publisherClaim: { findUnique: vi.fn().mockResolvedValue(null), create } });
        const routes = creatorRoutes({ reader: reader([`acme/one`]), fetchFn: servingFetch({}) });

        await expectOrpcCode(call(routes.claim, { publisher: `acme` }, { context: context({ prisma }) }), `FORBIDDEN`);
        expect(create).not.toHaveBeenCalled();
    });

    it(`leaves a name that another account already holds with that account`, async () => {
        const create = vi.fn();
        const token = claimToken(baseConfig, user.id, `acme`);
        const prisma = fakePrisma({
            publisherClaim: { findUnique: vi.fn().mockResolvedValue({ userId: `someone-else`, publisher: `acme`, repo: `acme/one` }), create },
        });
        // Even holding a valid proof: first-come is the rule the registry already uses for slugs.
        const routes = creatorRoutes({ reader: reader([`acme/one`]), fetchFn: servingFetch({ [rawUrl(`acme/one`)]: token }) });

        await expectOrpcCode(call(routes.claim, { publisher: `acme` }, { context: context({ prisma }) }), `CONFLICT`);
        expect(create).not.toHaveBeenCalled();
    });

    it(`re-claiming a name you already hold answers with the existing claim`, async () => {
        const create = vi.fn();
        const prisma = fakePrisma({
            publisherClaim: {
                findUnique: vi
                    .fn()
                    .mockResolvedValue({ userId: `u1`, publisher: `acme`, repo: `acme/one`, createdAt: new Date(`2026-08-01T00:00:00Z`) }),
                create,
            },
        });
        const routes = creatorRoutes({ reader: reader([`acme/one`]), fetchFn: servingFetch({}) });

        const result = await call(routes.claim, { publisher: `acme` }, { context: context({ prisma }) });

        expect(result.repo).toBe(`acme/one`);
        expect(create).not.toHaveBeenCalled();
    });

    it(`challenge states what to publish and where, without writing anything`, async () => {
        const prisma = fakePrisma({ publisherClaim: { findUnique: vi.fn().mockResolvedValue(null) } });
        const routes = creatorRoutes({ reader: reader([`acme/one`, `acme/two`]) });

        const result = await call(routes.challenge, { publisher: `acme` }, { context: context({ prisma }) });

        expect(result).toEqual({
            publisher: `acme`,
            repos: [`acme/one`, `acme/two`],
            path: CLAIM_PATH,
            token: claimToken(baseConfig, user.id, `acme`),
            claimedByYou: false,
            claimedByOther: false,
        });
    });

    it(`challenge still answers when the registry cannot be read`, async () => {
        const prisma = fakePrisma({ publisherClaim: { findUnique: vi.fn().mockResolvedValue(null) } });
        const broken: RegistryReader = { reposOf: vi.fn(async () => Promise.reject(new Error(`registry down`))) };
        const routes = creatorRoutes({ reader: broken });

        const result = await call(routes.challenge, { publisher: `acme` }, { context: context({ prisma }) });

        expect(result.repos).toEqual([]);
        expect(result.token).not.toBe(``);
    });

    it(`the whole surface is absent on a platform whose pool is off`, async () => {
        const routes = creatorRoutes({ reader: reader([]) });
        const off = context({ config: poolOffConfig });

        expect(await call(routes.status, {}, { context: off })).toEqual({ enabled: false, claims: [], statements: [], payments: [] });
        await expectOrpcCode(call(routes.challenge, { publisher: `acme` }, { context: off }), `NOT_FOUND`);
        await expectOrpcCode(call(routes.claim, { publisher: `acme` }, { context: off }), `NOT_FOUND`);
        await expectOrpcCode(call(routes.connectPayouts, {}, { context: off }), `NOT_FOUND`);
    });
});

describe(`payout connection`, () => {
    const gatewayWith = (overrides: Partial<StripeGateway>): StripeGateway => overrides as StripeGateway;

    it(`creates the connected account once and reuses it on every later visit`, async () => {
        const createAccount = vi.fn(async () => ({ id: `acct_1`, payoutsEnabled: false, detailsSubmitted: false }));
        const accountLink = vi.fn(async () => ({ url: `https://connect.stripe.test/setup` }));
        const create = vi.fn();
        const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ stripeAccountId: `acct_1` });
        const prisma = fakePrisma({ payoutAccount: { findUnique, create } });
        const routes = creatorRoutes({ gateway: gatewayWith({ createAccount, accountLink }) });

        const first = await call(routes.connectPayouts, {}, { context: context({ prisma }) });
        const second = await call(routes.connectPayouts, {}, { context: context({ prisma }) });

        expect(first.url).toBe(`https://connect.stripe.test/setup`);
        expect(second.url).toBe(`https://connect.stripe.test/setup`);
        // One account for one creator: a second would be a payee the platform then has to pay across.
        expect(createAccount).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledTimes(1);
        expect(accountLink).toHaveBeenCalledTimes(2);
    });

    it(`status refreshes an unfinished account through to Stripe and mirrors what comes back`, async () => {
        const account = vi.fn(async () => ({ id: `acct_1`, payoutsEnabled: true, detailsSubmitted: true }));
        const update = vi.fn();
        const prisma = fakePrisma({
            publisherClaim: { findMany: vi.fn().mockResolvedValue([]) },
            payoutAccount: {
                findUnique: vi
                    .fn()
                    .mockResolvedValue({ stripeAccountId: `acct_1`, payoutsEnabled: false, detailsSubmitted: false, disabledReason: `pending` }),
                update,
            },
        });
        const routes = creatorRoutes({ gateway: gatewayWith({ account }) });

        const result = await call(routes.status, {}, { context: context({ prisma }) });

        expect(result.payouts).toEqual({ connected: true, payoutsEnabled: true, detailsSubmitted: true });
        // A resolved cause must stop being displayed, so it is written back as null rather than left alone.
        expect(update).toHaveBeenCalledWith({
            where: { userId: `u1` },
            data: { payoutsEnabled: true, detailsSubmitted: true, disabledReason: null },
        });
    });

    it(`falls back to the stored answer when Stripe cannot be reached, and never invents readiness`, async () => {
        const account = vi.fn(async () => Promise.reject(new Error(`stripe down`)));
        const prisma = fakePrisma({
            publisherClaim: { findMany: vi.fn().mockResolvedValue([]) },
            payoutAccount: {
                findUnique: vi.fn().mockResolvedValue({
                    stripeAccountId: `acct_1`,
                    payoutsEnabled: false,
                    detailsSubmitted: true,
                    disabledReason: `requirements.past_due`,
                }),
                update: vi.fn(),
            },
        });
        const routes = creatorRoutes({ gateway: gatewayWith({ account }) });

        const result = await call(routes.status, {}, { context: context({ prisma }) });

        expect(result.payouts).toEqual({ connected: true, payoutsEnabled: false, detailsSubmitted: true, disabledReason: `requirements.past_due` });
    });

    it(`a creator who has not started reads as unconnected rather than as an error`, async () => {
        const account = vi.fn();
        const prisma = fakePrisma({
            publisherClaim: { findMany: vi.fn().mockResolvedValue([]) },
            payoutAccount: { findUnique: vi.fn().mockResolvedValue(null) },
        });
        const routes = creatorRoutes({ gateway: gatewayWith({ account }) });

        const result = await call(routes.status, {}, { context: context({ prisma }) });

        expect(result).toEqual({
            enabled: true,
            claims: [],
            statements: [],
            payments: [],
            payouts: { connected: false, payoutsEnabled: false, detailsSubmitted: false },
        });
        // Nothing to refresh, so Stripe is not called at all.
        expect(account).not.toHaveBeenCalled();
    });

    it(`a ready account is answered from the row, without a Stripe round-trip`, async () => {
        const account = vi.fn();
        const prisma = fakePrisma({
            publisherClaim: {
                findMany: vi.fn().mockResolvedValue([{ publisher: `acme`, repo: `acme/one`, createdAt: new Date(`2026-08-01T00:00:00Z`) }]),
            },
            creatorStatement: { findMany: vi.fn().mockResolvedValue([]) },
            payoutAccount: {
                findUnique: vi
                    .fn()
                    .mockResolvedValue({ stripeAccountId: `acct_1`, payoutsEnabled: true, detailsSubmitted: true, disabledReason: null }),
            },
        });
        const routes = creatorRoutes({ gateway: gatewayWith({ account }) });

        const result = await call(routes.status, {}, { context: context({ prisma }) });

        expect(result.claims).toEqual([{ publisher: `acme`, repo: `acme/one`, claimedAt: `2026-08-01T00:00:00.000Z` }]);
        expect(account).not.toHaveBeenCalled();
    });

    it(`shows earnings for a name claimed AFTER the month closed, and hides money already swept away`, async () => {
        const findMany = vi.fn().mockResolvedValue([
            {
                month: `2026-07`,
                publisher: `acme`,
                amountCents: 12_840,
                expiresAt: new Date(`2027-08-01T00:00:00Z`),
                poolMonth: { payableAt: new Date(`2026-08-15T00:00:00Z`) },
            },
        ]);
        const prisma = fakePrisma({
            // Claimed in August, for a month that closed before the claim existed — statements are never bound
            // to a user, so this simply works.
            publisherClaim: {
                findMany: vi.fn().mockResolvedValue([{ publisher: `acme`, repo: `acme/one`, createdAt: new Date(`2026-08-09T00:00:00Z`) }]),
            },
            creatorStatement: { findMany },
            payoutAccount: { findUnique: vi.fn().mockResolvedValue(null) },
        });
        const routes = creatorRoutes({ gateway: gatewayWith({ account: vi.fn() }) });

        const result = await call(routes.status, {}, { context: context({ prisma }) });

        expect(result.statements).toEqual([
            {
                month: `2026-07`,
                publisher: `acme`,
                amountCents: 12_840,
                payableAt: `2026-08-15T00:00:00.000Z`,
                expiresAt: `2027-08-01T00:00:00.000Z`,
            },
        ]);
        /* This list is what is still OWED, so it excludes both kinds of money that is no longer owed: swept
         * (expired back into the pool) and already settled. Listing either as an earning would double-count
         * against the receipts below it. */
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { publisher: { in: [`acme`] }, expiredAt: null, payoutId: null } }));
    });
});
