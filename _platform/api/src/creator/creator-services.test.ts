import { createHmac } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { StripeGateway } from "../pool/pool-stripe.js";
import { draftService, listServices, probeOwnService, publishService, rotateServiceSecret, updateService, withdrawService, type ServiceDeps } from "./creator-services.js";

/* THE PROVIDER'S SIX OPERATIONS, end to end without a network, a Stripe account or a provider, which is the
 * point of the injectable shape: a whole admission, from draft to live, runs in a millisecond here.
 *
 * What these pin down is the awkward half of the design. Publishing lands in PROBATION rather than listed;
 * an endpoint swap costs a live listing its admission; a price move is rate-limited but not blocked. Each of
 * those is a decision someone will later be tempted to soften, and each has a reason recorded beside it. */

const NOW = new Date(`2026-08-17T12:00:00.000Z`);

const config = {
    secrets: { key: `` },
    pool: {
        openAdmission: true,
        serviceMinCredits: 1,
        serviceMaxCredits: 200,
        probationMaxCredits: 25,
        probeFreshMinutes: 60,
        graduationRuns: 50,
        maxRefundRate: 0.2,
        watchWindowRuns: 20,
        canaryFailures: 3,
        priceChangeHours: 24,
        maxServicesPerOwner: 5,
    },
} as unknown as Config;

const INPUT = {
    slug: `acme-research`,
    publisher: `acme`,
    name: `Acme Research`,
    description: `Deep research across two hundred communities, ranked and summarised for a launch plan.`,
    upstreamUrl: `https://svc.acme.test/run`,
    creditsPerRun: 10,
    sampleRequest: `{"query":"where should we launch?"}`,
};

interface Row extends Record<string, unknown> {
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
    userId: string | null;
    probedAt: Date | null;
    canaryFails: number;
    suspendedFor: string | null;
    pricedAt: Date | null;
    createdAt: Date;
}

const fakePrisma = (seed: { services?: Row[]; claims?: string[] } = {}) => {
    const services = seed.services ?? [];
    const claims = seed.claims ?? [`acme`];
    let next = services.length + 1;
    const prisma = {
        service: {
            findFirst: vi.fn(async ({ where }: { where: { slug?: string; userId?: string } }) =>
                services.find((row) => (where.slug === undefined || row.slug === where.slug) && (where.userId === undefined || row.userId === where.userId)) ?? null,
            ),
            findUnique: vi.fn(async ({ where }: { where: { slug: string } }) => services.find((row) => row.slug === where.slug) ?? null),
            findMany: vi.fn(async ({ where }: { where: { userId: string } }) => services.filter((row) => row.userId === where.userId)),
            count: vi.fn(async ({ where }: { where: { userId: string; status: { in?: string[]; not?: string } } }) =>
                services.filter(
                    (row) =>
                        row.userId === where.userId &&
                        (where.status.in !== undefined ? where.status.in.includes(row.status) : row.status !== where.status.not),
                ).length,
            ),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                const row = {
                    id: `svc_${next++}`,
                    probedAt: null,
                    canaryFails: 0,
                    suspendedFor: null,
                    pricedAt: null,
                    createdAt: NOW,
                    ...data,
                } as Row;
                services.push(row);
                return row;
            }),
            update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                const row = services.find((entry) => entry.id === where.id);
                Object.assign(row ?? {}, data);
                return row;
            }),
        },
        publisherClaim: {
            findFirst: vi.fn(async ({ where }: { where: { publisher: string } }) =>
                claims.includes(where.publisher) ? { id: `claim_1` } : null,
            ),
            count: vi.fn(async () => claims.length),
        },
        serviceRun: { groupBy: vi.fn(async () => []) },
        serviceProbe: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
        payoutAccount: { findUnique: vi.fn(async () => ({ stripeAccountId: `acct_1`, payoutsEnabled: true, detailsSubmitted: true, disabledReason: null })) },
    } as unknown as PrismaClient;
    return { prisma, services };
};

const signatureOf = (secret: string, timestamp: string, body: string): string =>
    createHmac(`sha256`, secret).update(`${timestamp}.${body}`).digest(`hex`);

// A correct provider, signed against whatever secret the platform minted for the listing under test.
const goodProvider = (secretOf: () => string): typeof fetch =>
    (async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        const timestamp = headers.get(`x-intentic-timestamp`) ?? ``;
        const body = String(init.body ?? ``);
        const signed = headers.get(`x-intentic-signature`) === signatureOf(secretOf(), timestamp, body);
        const fresh = Math.abs(NOW.getTime() / 1000 - Number(timestamp)) <= 300;
        if (!signed || !fresh) {
            return new Response(`no`, { status: 401 });
        }
        return new Response(`${JSON.stringify({ event: `result`, data: { ok: true } })}\n`, {
            status: 200,
            headers: { "content-type": `application/x-ndjson` },
        });
    }) as unknown as typeof fetch;

const gateway = {} as StripeGateway;

// DNS that answers public space, so a whole admission runs against a hostname that was never meant to exist.
const publicLookup = vi.fn(async () => [{ address: `93.184.216.34`, family: 4 }]) as unknown as ServiceDeps[`lookupFn`];

const depsOf = (prisma: PrismaClient, fetchFn?: typeof fetch): ServiceDeps => ({
    prisma,
    config,
    gateway,
    fetchFn,
    now: () => NOW,
    lookupFn: publicLookup,
});

describe(`a provider listing a service`, () => {
    it(`mints a secret once at draft and never reads it back`, async () => {
        const { prisma } = fakePrisma();
        const created = await draftService(depsOf(prisma), `user-1`, INPUT);
        expect(created.secret).toMatch(/^[0-9a-f]{48}$/);
        expect(created.service.status).toBe(`draft`);
        const listed = await listServices(depsOf(prisma), `user-1`);
        expect(listed.services[0]).not.toHaveProperty(`secret`);
    });

    it(`refuses a draft under a publisher name the account has not proved`, async () => {
        const { prisma } = fakePrisma({ claims: [] });
        await expect(draftService(depsOf(prisma), `user-1`, INPUT)).rejects.toThrow(/not proved/);
    });

    it(`refuses a draft that breaks the published rules, naming all of them`, async () => {
        const { prisma } = fakePrisma();
        await expect(draftService(depsOf(prisma), `user-1`, { ...INPUT, name: `x`, creditsPerRun: 9_000 })).rejects.toThrow(/name must be.*price must be/s);
    });

    /* The whole point of the change: passing the gates lists it, with no operator in the loop, and lands it
     * in probation, which is what makes saying that safe. */
    it(`goes live into probation the moment the gates pass, with no operator`, async () => {
        const { prisma, services } = fakePrisma();
        const created = await draftService(depsOf(prisma), `user-1`, INPUT);
        const probe = await probeOwnService(depsOf(prisma, goodProvider(() => created.secret)), `user-1`, INPUT.slug);
        expect(probe.passed).toBe(true);
        const published = await publishService(depsOf(prisma), `user-1`, INPUT.slug);
        expect(published.status).toBe(`probation`);
        expect(services[0]?.status).toBe(`probation`);
    });

    it(`refuses to publish without a fresh passing probe`, async () => {
        const { prisma } = fakePrisma();
        await draftService(depsOf(prisma), `user-1`, INPUT);
        await expect(publishService(depsOf(prisma), `user-1`, INPUT.slug)).rejects.toThrow(/conformance probe/);
    });

    it(`clears the probe stamp when the probe fails, so a bad endpoint cannot publish`, async () => {
        const { prisma, services } = fakePrisma();
        const created = await draftService(depsOf(prisma), `user-1`, INPUT);
        await probeOwnService(depsOf(prisma, goodProvider(() => created.secret)), `user-1`, INPUT.slug);
        expect(services[0]?.probedAt).not.toBeNull();
        // A provider that stopped verifying: it now answers everything, including the forged call.
        const permissive = (async () =>
            new Response(`${JSON.stringify({ event: `result`, data: {} })}\n`, { status: 200 })) as unknown as typeof fetch;
        const again = await probeOwnService(depsOf(prisma, permissive), `user-1`, INPUT.slug);
        expect(again.passed).toBe(false);
        expect(services[0]?.probedAt).toBeNull();
    });

    it(`hides another account's listing behind the same answer as one that does not exist`, async () => {
        const { prisma } = fakePrisma();
        await draftService(depsOf(prisma), `user-1`, INPUT);
        await expect(publishService(depsOf(prisma), `user-2`, INPUT.slug)).rejects.toThrow(/no listing called/);
    });

    /* The live-listing cap bounds nothing if drafts are unlimited: unlimited drafts are unlimited rows and
     * unlimited slugs held out of the namespace. Suspended rows are exempt: they are history somebody's
     * earnings hang off. */
    it(`counts drafts against the per-account cap, but not suspended history`, async () => {
        const { prisma, services } = fakePrisma();
        for (let i = 0; i < 5; i += 1) {
            await draftService(depsOf(prisma), `user-1`, { ...INPUT, slug: `acme-${i}` });
        }
        await expect(draftService(depsOf(prisma), `user-1`, { ...INPUT, slug: `acme-6` })).rejects.toThrow(/drafts included/);
        const first = services[0];
        if (first !== undefined) {
            first.status = `suspended`;
        }
        await expect(draftService(depsOf(prisma), `user-1`, { ...INPUT, slug: `acme-6` })).resolves.toMatchObject({
            service: { slug: `acme-6` },
        });
    });

    it(`refuses a slug that is taken`, async () => {
        const { prisma } = fakePrisma();
        await draftService(depsOf(prisma), `user-1`, INPUT);
        await expect(draftService(depsOf(prisma), `user-1`, INPUT)).rejects.toThrow(/taken/);
    });
});

describe(`a provider changing a live listing`, () => {
    const live = async () => {
        const fake = fakePrisma();
        const created = await draftService(depsOf(fake.prisma), `user-1`, INPUT);
        await probeOwnService(depsOf(fake.prisma, goodProvider(() => created.secret)), `user-1`, INPUT.slug);
        await publishService(depsOf(fake.prisma), `user-1`, INPUT.slug);
        return fake;
    };

    /* An endpoint that can be swapped after admission would make the probe decorative: it proves an
     * endpoint, not a promise. The swap costs a re-probe and a fresh trip through probation. */
    it(`drops a live listing back to draft when its endpoint moves`, async () => {
        const { prisma, services } = await live();
        const updated = await updateService(depsOf(prisma), `user-1`, INPUT.slug, { upstreamUrl: `https://svc2.acme.test/run` });
        expect(updated.status).toBe(`draft`);
        expect(services[0]?.probedAt).toBeNull();
    });

    it(`leaves a listing live when only its prose changes`, async () => {
        const { prisma } = await live();
        const updated = await updateService(depsOf(prisma), `user-1`, INPUT.slug, { name: `Acme Deep Research` });
        expect(updated.status).toBe(`probation`);
    });

    it(`rate-limits a price move rather than blocking it`, async () => {
        const { prisma } = await live();
        await updateService(depsOf(prisma), `user-1`, INPUT.slug, { creditsPerRun: 12 });
        await expect(updateService(depsOf(prisma), `user-1`, INPUT.slug, { creditsPerRun: 14 })).rejects.toThrow(/once every 24 hours/);
        // A day later the same move is fine.
        const later = { ...depsOf(prisma), now: () => new Date(NOW.getTime() + 25 * 3_600_000) };
        await expect(updateService(later, `user-1`, INPUT.slug, { creditsPerRun: 14 })).resolves.toMatchObject({ creditsPerRun: 14 });
    });

    it(`holds a probation listing under the probation ceiling`, async () => {
        const { prisma } = await live();
        await expect(updateService(depsOf(prisma), `user-1`, INPUT.slug, { creditsPerRun: 100 })).rejects.toThrow(/probation the price ceiling/);
    });

    it(`withdraws to draft rather than deleting, because the runs are somebody's earnings`, async () => {
        const { prisma, services } = await live();
        const withdrawn = await withdrawService(depsOf(prisma), `user-1`, INPUT.slug);
        expect(withdrawn.status).toBe(`draft`);
        expect(services).toHaveLength(1);
    });

    it(`rotates a signing secret to something new, answered once`, async () => {
        const { prisma } = await live();
        const first = await rotateServiceSecret(depsOf(prisma), `user-1`, INPUT.slug);
        const second = await rotateServiceSecret(depsOf(prisma), `user-1`, INPUT.slug);
        expect(first.secret).not.toBe(second.secret);
        expect(second.secret).toMatch(/^[0-9a-f]{48}$/);
    });
});

describe(`a platform with self-serve turned off`, () => {
    const closed = { ...config, pool: { ...config.pool, openAdmission: false } } as Config;

    it(`refuses every write but still answers the read, so the screen can explain`, async () => {
        const { prisma } = fakePrisma();
        const deps = { prisma, config: closed, gateway, now: () => NOW };
        await expect(draftService(deps, `user-1`, INPUT)).rejects.toThrow(/does not take self-serve/);
        await expect(listServices(deps, `user-1`)).resolves.toMatchObject({ services: [] });
    });
});
