import { call, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import type { StripeGateway } from "../pool/pool-stripe.js";
import type { lookup } from "node:dns/promises";
import {
    CLAIM_PATH,
    DOMAIN_CLAIM_PATH,
    checkClaim,
    checkDomainClaim,
    claimFailureReason,
    claimToken,
    domainClaimFailureReason,
    domainClaimProblem,
    registryReader,
    type RegistryReader,
} from "./creator-claim.js";
import { creatorRoutes } from "./creator.orpc.js";

/* WHAT A CREATOR WOULD CALL THEFT IF IT DRIFTED. Phase one owns exactly two promises: a publisher name is
 * yours only if you proved it, and money only moves somewhere you connected, so what is pinned here is the
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

// A pool that is off: no key, no price, the self-hosted default.
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

const reader = (repos: readonly string[], names: readonly { publisher: string; repos: readonly string[] }[] = []): RegistryReader => ({
    reposOf: vi.fn(async () => repos),
    publishersOf: vi.fn(async () => names),
});

const expectOrpcCode = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(code);
};

// A fetch that serves one repo's claim file and 404s everything else: the shape a real claim has, where the
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

        const report = await checkClaim(baseConfig, reader([`acme/first`, `acme/second`]), user.id, `acme`, fetchFn);

        // Found on the second repo: every listing is tried, so a creator never has to guess which one is read.
        expect(report.repo).toBe(`acme/second`);
        // And the report says what EACH one said, which is what the refusal sentence is built from.
        expect(report.attempts).toEqual([
            { repo: `acme/first`, outcome: `absent` },
            { repo: `acme/second`, outcome: `matched` },
        ]);
    });

    it(`refuses a token minted for a different account or a different publisher`, async () => {
        const otherUsers = claimToken(baseConfig, `u2`, `acme`);
        const otherName = claimToken(baseConfig, user.id, `other`);

        for (const wrong of [otherUsers, otherName]) {
            const report = await checkClaim(baseConfig, reader([`acme/first`]), user.id, `acme`, servingFetch({ [rawUrl(`acme/first`)]: wrong }));
            expect(report.repo).toBeUndefined();
            // A file that is THERE but wrong is its own outcome: telling this creator "no file found" would send
            // them to push the same wrong line again.
            expect(report.attempts).toEqual([{ repo: `acme/first`, outcome: `mismatched` }]);
        }
    });

    it(`survives a repository that errors, and refuses when the publisher has no listed repositories`, async () => {
        const token = claimToken(baseConfig, user.id, `acme`);
        const flaky = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === rawUrl(`acme/dead`)) {
                throw new Error(`connection refused`);
            }
            return new Response(token, { status: 200 });
        }) as unknown as typeof fetch;

        const report = await checkClaim(baseConfig, reader([`acme/dead`, `acme/live`]), user.id, `acme`, flaky);
        expect(report.repo).toBe(`acme/live`);
        expect(report.attempts).toEqual([
            { repo: `acme/dead`, outcome: `unreadable` },
            { repo: `acme/live`, outcome: `matched` },
        ]);
        expect(await checkClaim(baseConfig, reader([]), user.id, `acme`, flaky)).toEqual({ attempts: [] });
    });

    /* THE REFUSAL HAS TO SAY WHAT WAS READ. The old one said only that nothing carrying the token was readable,
     * which from the creator's chair is indistinguishable from the platform never having looked, and it sent
     * someone whose file was there-but-wrong to push the same wrong file again. */
    it(`explains a failed claim in terms of what each repository actually said`, () => {
        expect(claimFailureReason(`acme`, { attempts: [] })).toContain(`lists no GitHub-backed extension under acme`);

        const mismatched = claimFailureReason(`acme`, {
            attempts: [
                { repo: `acme/one`, outcome: `mismatched` },
                { repo: `acme/two`, outcome: `absent` },
            ],
        });
        expect(mismatched).toContain(`acme/one already carries a ${CLAIM_PATH}`);
        expect(mismatched).toContain(`not the line minted for your account`);

        const outage = claimFailureReason(`acme`, { attempts: [{ repo: `acme/one`, outcome: `unreadable` }] });
        expect(outage).toContain(`That is GitHub, not you`);

        const nothingYet = claimFailureReason(`acme`, {
            attempts: [`acme/one`, `acme/two`, `acme/three`].map((repo) => ({ repo, outcome: `absent` as const })),
        });
        expect(nothingYet).toContain(`Read all 3 repositories listed under acme`);
        // The branch trap is the single most likely reason a creator who "did it" is still not verified.
        expect(nothingYet).toContain(`landed on another branch`);
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
        // Second read inside the window is served from cache: a claim screen must not re-fetch per visit.
        expect(fetchFn).toHaveBeenCalledTimes(1);

        /* THE SAME FILE READ BACKWARDS: repositories a creator already has, to the names they back. This is
         * what lets the screen offer a name instead of asking for one, and it must survive the two things real
         * remotes do: differ in case from the listing, and appear under a publisher more than once. */
        expect(await registry.publishersOf([`ACME/One`, `acme/two`, `nobody/thing`])).toEqual([
            { publisher: `acme`, repos: [`acme/one`, `acme/two`] },
        ]);
        expect(await registry.publishersOf([])).toEqual([]);
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

    /* THE EMPTY BOX WAS THE WORST PART OF THIS SCREEN. A creator does not necessarily know that the name to type
     * is the publisher half of an extension id, and typing it wrong looks exactly like having nothing to claim.
     * So the screen sends what it has and the platform answers with names that can actually succeed. */
    it(`claimable offers names the caller's own repositories back, minus ones already settled`, async () => {
        const prisma = fakePrisma({ publisherClaim: { findMany: vi.fn().mockResolvedValue([{ publisher: `taken` }]) } });
        const routes = creatorRoutes({
            reader: reader(
                [],
                [
                    { publisher: `acme`, repos: [`acme/one`] },
                    { publisher: `taken`, repos: [`taken/one`] },
                ],
            ),
        });

        const result = await call(routes.claimable, { projects: [`acme/one`, `taken/one`] }, { context: context({ prisma }) });

        // `taken` is gone: a settled name is not a next step, it is somebody's answer.
        expect(result).toEqual({ names: [{ publisher: `acme`, repos: [`acme/one`] }] });
    });

    it(`claimable answers empty rather than failing when the registry is down`, async () => {
        const prisma = fakePrisma({ publisherClaim: { findMany: vi.fn() } });
        const broken: RegistryReader = {
            reposOf: vi.fn(async () => []),
            publishersOf: vi.fn(async () => {
                throw new Error(`registry down`);
            }),
        };

        // A suggestion list that fails is a missing convenience; the text box below it still claims.
        expect(await call(creatorRoutes({ reader: broken }).claimable, { projects: [`acme/one`] }, { context: context({ prisma }) })).toEqual({
            names: [],
        });
    });

    it(`challenge still answers when the registry cannot be read`, async () => {
        const prisma = fakePrisma({ publisherClaim: { findUnique: vi.fn().mockResolvedValue(null) } });
        const broken: RegistryReader = {
            reposOf: vi.fn(async () => {
                throw new Error(`registry down`);
            }),
            publishersOf: vi.fn(async () => {
                throw new Error(`registry down`);
            }),
        };
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

    it(`passes a Stripe refusal on in words, rather than letting it become a bare 500`, async () => {
        // The two things that really stop this route: Connect not enabled on the platform's account, an
        // account that cannot be onboarded: are both fixed by someone READING the reason. A raw throw
        // serializes as "Internal server error" on the one card whose job is saying what to do next.
        const createAccount = vi.fn(async () => {
            throw new Error(`Stripe refused: sign up for Connect to create accounts.`);
        });
        const prisma = fakePrisma({ payoutAccount: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() } });
        const routes = creatorRoutes({ gateway: gatewayWith({ createAccount }) });

        const error = await call(routes.connectPayouts, {}, { context: context({ prisma }) }).then(
            () => undefined,
            (thrown: unknown) => thrown,
        );

        expect(error).toBeInstanceOf(ORPCError);
        expect((error as ORPCError<string, unknown>).code).toBe(`BAD_GATEWAY`);
        expect((error as ORPCError<string, unknown>).message).toContain(`sign up for Connect`);
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
        const account = vi.fn(async () => {
            throw new Error(`stripe down`);
        });
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
            // Claimed in August, for a month that closed before the claim existed: statements are never bound
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

/* THE DOMAIN LANE: the same proof served from the name itself, for a business with a service to sell and no
 * extension in the registry. What is pinned: the dot picks the lane, the well-known read is the whole check,
 * a private-resolving name is never fetched, and the refusal names the URL that was read. */
describe(`domain claims`, () => {
    const wellKnown = (domain: string) => `https://${domain}/${DOMAIN_CLAIM_PATH}`;
    const publicLookup = vi.fn(async () => [{ address: `203.0.113.7`, family: 4 }]) as unknown as typeof lookup;
    const privateLookup = vi.fn(async () => [{ address: `127.0.0.1`, family: 4 }]) as unknown as typeof lookup;

    it(`accepts a domain serving THIS user's token at the well-known path`, async () => {
        const token = claimToken(baseConfig, user.id, `acme.dev`);
        const report = await checkDomainClaim(baseConfig, user.id, `acme.dev`, servingFetch({ [wellKnown(`acme.dev`)]: `${token}\n` }), publicLookup);
        expect(report.repo).toBe(`acme.dev`);
        expect(report.attempts).toEqual([{ repo: `acme.dev`, outcome: `matched` }]);
    });

    it(`tells apart a wrong token, a missing file, and an unreadable domain`, async () => {
        const someoneElses = claimToken(baseConfig, `u2`, `acme.dev`);
        const mismatched = await checkDomainClaim(
            baseConfig,
            user.id,
            `acme.dev`,
            servingFetch({ [wellKnown(`acme.dev`)]: someoneElses }),
            publicLookup,
        );
        expect(mismatched.attempts).toEqual([{ repo: `acme.dev`, outcome: `mismatched` }]);

        const absent = await checkDomainClaim(baseConfig, user.id, `acme.dev`, servingFetch({}), publicLookup);
        expect(absent.attempts).toEqual([{ repo: `acme.dev`, outcome: `absent` }]);

        const dead = vi.fn(async () => {
            throw new Error(`connection refused`);
        }) as unknown as typeof fetch;
        const unreadable = await checkDomainClaim(baseConfig, user.id, `acme.dev`, dead, publicLookup);
        expect(unreadable.attempts).toEqual([{ repo: `acme.dev`, outcome: `unreadable` }]);
    });

    it(`never fetches a domain that resolves privately`, async () => {
        const fetchFn = vi.fn() as unknown as typeof fetch;
        const report = await checkDomainClaim(baseConfig, user.id, `internal.corp`, fetchFn, privateLookup);
        expect(report.repo).toBeUndefined();
        expect(report.attempts).toEqual([{ repo: `internal.corp`, outcome: `unreadable` }]);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it(`refuses IPs and reserved words before any network is touched`, () => {
        expect(domainClaimProblem(`192.168.0.1`)).toContain(`not an IP address`);
        expect(domainClaimProblem(`not-intentic.dev`)).toContain(`reserved`);
        expect(domainClaimProblem(`acme.dev`)).toBeUndefined();
    });

    it(`explains a failed domain claim in terms of the URL that was read`, () => {
        const at = wellKnown(`acme.dev`);
        expect(domainClaimFailureReason(`acme.dev`, { attempts: [{ repo: `acme.dev`, outcome: `mismatched` }] })).toContain(
            `${at} serves a token, but not the line minted for your account`,
        );
        expect(domainClaimFailureReason(`acme.dev`, { attempts: [{ repo: `acme.dev`, outcome: `absent` }] })).toContain(
            `Serve the line shown here as plain text`,
        );
        expect(domainClaimFailureReason(`acme.dev`, { attempts: [{ repo: `acme.dev`, outcome: `unreadable` }] })).toContain(`must resolve publicly`);
    });

    it(`challenge for a dotted name answers the well-known path, with no registry read`, async () => {
        const prisma = fakePrisma({ publisherClaim: { findUnique: vi.fn().mockResolvedValue(null) } });
        const broken: RegistryReader = {
            reposOf: vi.fn(async () => {
                throw new Error(`must not be read`);
            }),
            publishersOf: vi.fn(async () => {
                throw new Error(`must not be read`);
            }),
        };

        const result = await call(creatorRoutes({ reader: broken }).challenge, { publisher: `acme.dev` }, { context: context({ prisma }) });

        expect(result).toEqual({
            publisher: `acme.dev`,
            repos: [],
            path: DOMAIN_CLAIM_PATH,
            token: claimToken(baseConfig, user.id, `acme.dev`),
            claimedByYou: false,
            claimedByOther: false,
        });
    });

    it(`challenge refuses an unclaimable domain with the problem itself`, async () => {
        const prisma = fakePrisma({ publisherClaim: { findUnique: vi.fn().mockResolvedValue(null) } });
        await expectOrpcCode(
            call(creatorRoutes({ reader: reader([]) }).challenge, { publisher: `officially-verified.dev` }, { context: context({ prisma }) }),
            `BAD_REQUEST`,
        );
    });

    it(`claim records the domain that proved it`, async () => {
        const token = claimToken(baseConfig, user.id, `acme.dev`);
        const create = vi.fn().mockResolvedValue({ publisher: `acme.dev`, repo: `acme.dev`, createdAt: new Date(`2026-08-12T10:00:00Z`) });
        const prisma = fakePrisma({ publisherClaim: { findUnique: vi.fn().mockResolvedValue(null), create } });
        const routes = creatorRoutes({
            reader: reader([]),
            fetchFn: servingFetch({ [wellKnown(`acme.dev`)]: token }),
            lookupFn: publicLookup,
        });

        const result = await call(routes.claim, { publisher: `acme.dev` }, { context: context({ prisma }) });

        expect(create).toHaveBeenCalledWith({ data: { publisher: `acme.dev`, userId: `u1`, repo: `acme.dev` } });
        expect(result).toEqual({ publisher: `acme.dev`, repo: `acme.dev`, claimedAt: `2026-08-12T10:00:00.000Z` });
    });

    it(`claim refuses a domain with no readable proof, naming the URL, and writes nothing`, async () => {
        const create = vi.fn();
        const prisma = fakePrisma({ publisherClaim: { findUnique: vi.fn().mockResolvedValue(null), create } });
        const routes = creatorRoutes({ reader: reader([]), fetchFn: servingFetch({}), lookupFn: publicLookup });

        await expectOrpcCode(call(routes.claim, { publisher: `acme.dev` }, { context: context({ prisma }) }), `FORBIDDEN`);
        expect(create).not.toHaveBeenCalled();
    });
});
