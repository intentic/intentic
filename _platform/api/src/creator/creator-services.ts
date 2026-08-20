import { randomBytes } from "node:crypto";
import type { lookup } from "node:dns/promises";
import type { AdmissionRules, ProviderService, ServiceListingInput, ServiceProbeResult } from "@intentic-app/api-contract";
import type { PrismaClient } from "@intentic-app/prisma";
import { ORPCError } from "@orpc/server";
import type { Config } from "../config.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import {
    checkListingRules,
    LIVE_STATUSES,
    probeFailure,
    probeService,
    publishGates,
    type AdmissionDeps,
    type ServiceStatus,
} from "../pool/pool-admission.js";
import { payoutState } from "./creator-payouts.js";
import type { StripeGateway } from "../pool/pool-stripe.js";

/* THE PROVIDER'S SIDE OF OPEN ADMISSION, six operations that replace "email an operator and wait".
 *
 * Everything a provider can do to their own listing lives here, and the shape of it follows one rule: the
 * platform never decides anything this module could not tell them in advance. Rule failures come back as a
 * LIST of sentences rather than the first one, because a provider fixing four things should learn all four in
 * one round trip; gates are evaluated cheapest-first, so a listing with rule problems never spends a Stripe
 * read to also learn about payouts.
 *
 * WHAT IS DELIBERATELY AWKWARD: changing a live listing's endpoint drops it back to `draft`. A conforming
 * endpoint that can be swapped for an unproven one after admission would make gate 2 decorative, the probe
 * proves an endpoint, not a promise, so the swap costs a re-probe and a fresh trip through probation. Price
 * moves are rate-limited instead of blocked, because a price is a number a member reads before every single
 * click, not a trust boundary. */

export const admissionRules = (config: Config): AdmissionRules => ({
    openAdmission: config.pool.openAdmission,
    minCredits: config.pool.serviceMinCredits,
    maxCredits: config.pool.serviceMaxCredits,
    probationMaxCredits: config.pool.probationMaxCredits,
    probeFreshMinutes: config.pool.probeFreshMinutes,
    graduationRuns: config.pool.graduationRuns,
    maxRefundRate: config.pool.maxRefundRate,
    watchWindowRuns: config.pool.watchWindowRuns,
    canaryFailures: config.pool.canaryFailures,
    priceChangeHours: config.pool.priceChangeHours,
    maxServicesPerOwner: config.pool.maxServicesPerOwner,
});

/* What the provider's own view is built from, structurally, the pool modules' precedent, so this file's
 * logic is testable without the generated client. `secret` is absent by construction: it is answered once at
 * mint and once at rotation, and nothing ever reads it back. */
interface ServiceRow {
    readonly slug: string;
    readonly publisher: string;
    readonly name: string;
    readonly description: string;
    readonly upstreamUrl: string;
    readonly creditsPerRun: number;
    readonly sampleRequest: string;
    readonly status: string;
    readonly probedAt: Date | null;
    readonly suspendedFor: string | null;
    readonly createdAt: Date;
}

const viewOf = (row: ServiceRow, served: number, refunded: number): ProviderService => ({
    slug: row.slug,
    publisher: row.publisher,
    name: row.name,
    description: row.description,
    upstreamUrl: row.upstreamUrl,
    creditsPerRun: row.creditsPerRun,
    sampleRequest: row.sampleRequest,
    status: row.status as ServiceStatus,
    ...(row.probedAt !== null ? { probedAt: row.probedAt.toISOString() } : {}),
    ...(row.suspendedFor !== null ? { suspendedFor: row.suspendedFor } : {}),
    servedRuns: served,
    refundedRuns: refunded,
    createdAt: row.createdAt.toISOString(),
});

// Run counts for a set of listings in one grouped read rather than two queries per row. Exported because the
// public catalog (pool.routes.ts /catalog) states the same numbers to everyone, one derivation, two readers.
export const countsOf = async (prisma: PrismaClient, serviceIds: readonly string[]): Promise<Map<string, { served: number; refunded: number }>> => {
    const counts = new Map<string, { served: number; refunded: number }>();
    if (serviceIds.length === 0) {
        return counts;
    }
    const grouped = await prisma.serviceRun.groupBy({
        by: [`serviceId`, `status`],
        where: { serviceId: { in: [...serviceIds] } },
        _count: { _all: true },
    });
    for (const row of grouped) {
        const entry = counts.get(row.serviceId) ?? { served: 0, refunded: 0 };
        if (row.status === `refunded`) {
            entry.refunded += row._count._all;
        } else {
            entry.served += row._count._all;
        }
        counts.set(row.serviceId, entry);
    }
    return counts;
};

export interface ServiceDeps {
    readonly prisma: PrismaClient;
    readonly config: Config;
    readonly gateway: StripeGateway;
    readonly fetchFn?: typeof fetch;
    readonly now?: () => Date;
    // The probe resolves the endpoint's hostname before it calls it; injected so a test drives a whole
    // admission against a name that was never meant to exist.
    readonly lookupFn?: typeof lookup;
}

const admissionDeps = ({ prisma, gateway }: ServiceDeps): AdmissionDeps => ({
    holdsPublisher: async (userId, publisher) =>
        (await prisma.publisherClaim.findFirst({ where: { publisher, userId }, select: { id: true } })) !== null,
    payoutsEnabled: async (userId) => (await payoutState(prisma, gateway, userId)).payoutsEnabled,
    liveServiceCount: async (userId) => prisma.service.count({ where: { userId, status: { in: [...LIVE_STATUSES] } } }),
});

// Self-serve being off is a platform's choice, not a per-caller refusal, so every write says the same thing
// and the read still works, which is what lets the screen explain rather than break.
const requireOpen = (config: Config): void => {
    if (!config.pool.openAdmission) {
        throw new ORPCError(`NOT_FOUND`, { message: `This platform does not take self-serve service listings.` });
    }
};

const rulesRefusal = (problems: readonly string[]): ORPCError<string, unknown> =>
    new ORPCError(`BAD_REQUEST`, { message: problems.join(` `) });

// A listing this caller owns, or a 404, an owner asking about a slug that is someone else's must not learn
// whether it exists.
const ownedOr404 = async (prisma: PrismaClient, userId: string, slug: string) => {
    const row = await prisma.service.findFirst({ where: { slug, userId } });
    if (row === null) {
        throw new ORPCError(`NOT_FOUND`, { message: `You have no listing called ${slug}.` });
    }
    return row;
};

export const listServices = async (deps: ServiceDeps, userId: string) => {
    const { prisma, config, gateway } = deps;
    const [rows, claims, payouts] = await Promise.all([
        prisma.service.findMany({ where: { userId }, orderBy: { createdAt: `desc` } }),
        prisma.publisherClaim.count({ where: { userId } }),
        payoutState(prisma, gateway, userId),
    ]);
    const counts = await countsOf(
        prisma,
        rows.map((row) => row.id),
    );
    return {
        enabled: true,
        rules: admissionRules(config),
        services: rows.map((row) => {
            const count = counts.get(row.id) ?? { served: 0, refunded: 0 };
            return viewOf(row, count.served, count.refunded);
        }),
        holdsAnyPublisher: claims > 0,
        payoutsEnabled: payouts.payoutsEnabled,
    };
};

/* A new draft. The secret is minted here and answered exactly once, the provider needs it to verify
 * forwarded calls, and the platform keeps only the encrypted copy, so this response is the only time it
 * exists in readable form outside their own code.
 *
 * The publisher name is checked at creation as well as at publish. A draft filed under a name that is not
 * yours is a dead end, and finding that out after building the endpoint is the worst possible moment. */
export const draftService = async (deps: ServiceDeps, userId: string, input: ServiceListingInput) => {
    const { prisma, config } = deps;
    requireOpen(config);
    const problems = checkListingRules(config, input);
    if (problems.length > 0) {
        throw rulesRefusal(problems);
    }
    if (!(await admissionDeps(deps).holdsPublisher(userId, input.publisher))) {
        throw new ORPCError(`FORBIDDEN`, {
            message: `You have not proved that ${input.publisher} is yours. Settings → Payouts walks through claiming a publisher name.`,
        });
    }
    if ((await prisma.service.findUnique({ where: { slug: input.slug }, select: { id: true } })) !== null) {
        throw new ORPCError(`CONFLICT`, { message: `The slug ${input.slug} is taken.` });
    }
    /* The same cap the publish gate applies, counted here over drafts too, otherwise the live-listing limit
     * bounds nothing, because unlimited drafts are unlimited rows and unlimited slugs held out of the
     * namespace. SUSPENDED ROWS DO NOT COUNT: they are history somebody's earnings hang off, and making a
     * provider delete their record to list again would be the wrong incentive to build in. */
    const held = await prisma.service.count({ where: { userId, status: { not: `suspended` } } });
    if (held >= config.pool.maxServicesPerOwner) {
        throw new ORPCError(`BAD_REQUEST`, {
            message: `You already hold ${config.pool.maxServicesPerOwner} listings, drafts included, which is the limit per account.`,
        });
    }
    const secret = randomBytes(24).toString(`hex`);
    const row = await prisma.service.create({
        data: {
            slug: input.slug,
            publisher: input.publisher,
            name: input.name,
            description: input.description,
            upstreamUrl: input.upstreamUrl,
            creditsPerRun: input.creditsPerRun,
            sampleRequest: input.sampleRequest,
            secret: encryptSecret(config, secret),
            status: `draft`,
            userId,
        },
    });
    return { service: viewOf(row, 0, 0), secret };
};

export const updateService = async (deps: ServiceDeps, userId: string, slug: string, patch: Partial<Omit<ServiceListingInput, `slug` | `publisher`>>) => {
    const { prisma, config, now = () => new Date() } = deps;
    requireOpen(config);
    const row = await ownedOr404(prisma, userId, slug);
    const merged = {
        slug: row.slug,
        publisher: row.publisher,
        name: patch.name ?? row.name,
        description: patch.description ?? row.description,
        upstreamUrl: patch.upstreamUrl ?? row.upstreamUrl,
        creditsPerRun: patch.creditsPerRun ?? row.creditsPerRun,
        sampleRequest: patch.sampleRequest ?? row.sampleRequest,
    };
    const problems = [...checkListingRules(config, merged)];
    const live = LIVE_STATUSES.includes(row.status as ServiceStatus);
    const at = now();
    const priceMoved = merged.creditsPerRun !== row.creditsPerRun;
    if (priceMoved && row.pricedAt !== null) {
        const nextAllowed = row.pricedAt.getTime() + config.pool.priceChangeHours * 3_600_000;
        if (nextAllowed > at.getTime()) {
            problems.push(`A listing's price may move once every ${config.pool.priceChangeHours} hours. This one moved recently.`);
        }
    }
    if (priceMoved && row.status === `probation` && merged.creditsPerRun > config.pool.probationMaxCredits) {
        problems.push(`While on probation the price ceiling is ${config.pool.probationMaxCredits} credits.`);
    }
    if (problems.length > 0) {
        throw rulesRefusal(problems);
    }
    /* An endpoint swap invalidates the only thing gate 2 ever proved, so it costs the listing its admission:
     * back to draft, re-probe, publish again. A sample-request change only invalidates the probe, since it is
     * the probe's body, the listing stays live and the canary re-proves it. */
    const endpointMoved = merged.upstreamUrl !== row.upstreamUrl;
    const sampleMoved = merged.sampleRequest !== row.sampleRequest;
    const updated = await prisma.service.update({
        where: { id: row.id },
        data: {
            ...merged,
            ...(priceMoved ? { pricedAt: at } : {}),
            ...(endpointMoved || sampleMoved ? { probedAt: null, canaryFails: 0 } : {}),
            ...(endpointMoved && live ? { status: `draft`, suspendedFor: null } : {}),
        },
    });
    const counts = await countsOf(prisma, [row.id]);
    const count = counts.get(row.id) ?? { served: 0, refunded: 0 };
    return viewOf(updated, count.served, count.refunded);
};

/* Gate 2, on demand. Three calls to the provider's own endpoint with their own sample body: one correctly
 * signed that must serve, and two deliberately bad ones that must be refused. Every attempt is recorded,
 * passed or not, so a provider debugging a rejection has the history and a later suspension has its evidence. */
export const probeOwnService = async (deps: ServiceDeps, userId: string, slug: string): Promise<ServiceProbeResult> => {
    const { prisma, config, fetchFn = fetch, now = () => new Date(), lookupFn } = deps;
    requireOpen(config);
    const row = await ownedOr404(prisma, userId, slug);
    const verdict = await probeService(row.upstreamUrl, decryptSecret(config, row.secret), row.sampleRequest, fetchFn, now, lookupFn);
    await prisma.serviceProbe.create({
        data: { serviceId: row.id, passed: verdict.passed, kind: `publish`, detail: JSON.stringify(verdict.checks) },
    });
    await prisma.service.update({
        where: { id: row.id },
        data: verdict.passed ? { probedAt: now(), canaryFails: 0 } : { probedAt: null },
    });
    return { passed: verdict.passed, checks: [...verdict.checks], message: probeFailure(verdict) };
};

/* Gates 1 and 3, and the transition. A passing listing goes live IMMEDIATELY, into probation, no operator
 * click, which was the whole point. Probation is what makes that safe to say: a price ceiling, a badge on
 * every card a member sees, and the watch counting from the first run. */
export const publishService = async (deps: ServiceDeps, userId: string, slug: string) => {
    const { prisma, config, now = () => new Date() } = deps;
    requireOpen(config);
    const row = await ownedOr404(prisma, userId, slug);
    if (LIVE_STATUSES.includes(row.status as ServiceStatus)) {
        throw new ORPCError(`BAD_REQUEST`, { message: `${row.slug} is already live.` });
    }
    const verdict = await publishGates(admissionDeps(deps), config, userId, { ...row, status: row.status as ServiceStatus }, now());
    if (!verdict.ok) {
        throw rulesRefusal(verdict.problems);
    }
    const updated = await prisma.service.update({
        where: { id: row.id },
        data: { status: `probation`, suspendedFor: null, canaryFails: 0 },
    });
    const counts = await countsOf(prisma, [row.id]);
    const count = counts.get(row.id) ?? { served: 0, refunded: 0 };
    return viewOf(updated, count.served, count.refunded);
};

// A provider delisting their own listing. Back to draft, not deleted: the runs it served are on the public
// ledger and are somebody's earnings.
export const withdrawService = async (deps: ServiceDeps, userId: string, slug: string) => {
    const { prisma, config } = deps;
    requireOpen(config);
    const row = await ownedOr404(prisma, userId, slug);
    const updated = await prisma.service.update({ where: { id: row.id }, data: { status: `draft`, suspendedFor: null } });
    const counts = await countsOf(prisma, [row.id]);
    const count = counts.get(row.id) ?? { served: 0, refunded: 0 };
    return viewOf(updated, count.served, count.refunded);
};

/* A fresh signing secret, answered once. The old one stops working the moment this returns, so a live listing
 * will fail every forward until the provider deploys the new one, which is why this is a deliberate button
 * and not something any other operation does as a side effect. */
export const rotateServiceSecret = async (deps: ServiceDeps, userId: string, slug: string): Promise<{ secret: string }> => {
    const { prisma, config } = deps;
    requireOpen(config);
    const row = await ownedOr404(prisma, userId, slug);
    const secret = randomBytes(24).toString(`hex`);
    await prisma.service.update({ where: { id: row.id }, data: { secret: encryptSecret(config, secret) } });
    return { secret };
};
