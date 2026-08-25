import type { AdminMarket } from "@intentic-app/api-contract";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";

/* THE MARKETPLACE READ — demand beside supply. The wants aggregate is the platform's only demand signal
 * (agents filing "the catalog had nothing for this"), reduced exactly the way the public catalog reduces it
 * (distinct owners per normalized ask, newest phrasing) but over the operator's window and without the
 * public display cap's tightness. Supply is every listing — all statuses, unlike the public catalog — with
 * the counters the published rules judge it by. */

const DAY_MS = 24 * 60 * 60 * 1000;

// The demand window, matching the public aggregate's 90 days (retention keeps wants for 180).
const WANT_WINDOW_DAYS = 90;
const WANT_TOP = 50;

export const adminMarket = async (prisma: PrismaClient, config: Config, now: () => Date = () => new Date()): Promise<AdminMarket> => {
    const at = now();
    const weekStart = new Date(at.getTime() - 7 * DAY_MS);
    const [wantRows, services, servedAllTime, runs7d, publishers, payoutAccounts, pendingPayouts, unclaimed] = await Promise.all([
        prisma.serviceWant.findMany({
            where: { createdAt: { gte: new Date(at.getTime() - WANT_WINDOW_DAYS * DAY_MS) } },
            select: { userId: true, text: true, normalized: true, createdAt: true },
            orderBy: { createdAt: `asc` },
        }),
        prisma.service.findMany({
            select: {
                id: true,
                slug: true,
                publisher: true,
                name: true,
                status: true,
                creditsPerRun: true,
                userId: true,
                canaryFails: true,
                probedAt: true,
                suspendedFor: true,
            },
            orderBy: { slug: `asc` },
        }),
        // The graduation counter: every run this listing ever SERVED.
        prisma.serviceRun.groupBy({ by: [`serviceId`], where: { status: `ok` }, _count: { _all: true } }),
        // The recent-health window the panel derives a refund rate from.
        prisma.serviceRun.groupBy({ by: [`serviceId`, `status`], where: { createdAt: { gte: weekStart } }, _count: { _all: true } }),
        prisma.publisherClaim.count(),
        prisma.payoutAccount.count({ where: { payoutsEnabled: true } }),
        prisma.creatorPayout.aggregate({ where: { status: `pending` }, _sum: { amountCents: true } }),
        prisma.creatorStatement.aggregate({ where: { payoutId: null, expiredAt: null }, _sum: { amountCents: true } }),
    ]);

    // Distinct owners per normalized ask; ascending order above makes the last write the newest phrasing.
    const asks = new Map<string, { text: string; owners: Set<string>; lastAt: Date }>();
    for (const row of wantRows) {
        const entry = asks.get(row.normalized) ?? { text: row.text, owners: new Set<string>(), lastAt: row.createdAt };
        entry.owners.add(row.userId);
        entry.text = row.text;
        entry.lastAt = row.createdAt;
        asks.set(row.normalized, entry);
    }
    const wants = [...asks.values()]
        .map((entry) => ({ text: entry.text, owners: entry.owners.size, lastAt: entry.lastAt.toISOString() }))
        .toSorted((a, b) => b.owners - a.owners || b.lastAt.localeCompare(a.lastAt))
        .slice(0, WANT_TOP);

    const servedOf = new Map(servedAllTime.map((row) => [row.serviceId, row._count._all]));
    const weekOf = new Map<string, { runs: number; refunds: number }>();
    for (const row of runs7d) {
        const entry = weekOf.get(row.serviceId) ?? { runs: 0, refunds: 0 };
        entry.runs += row._count._all;
        if (row.status === `refunded`) {
            entry.refunds += row._count._all;
        }
        weekOf.set(row.serviceId, entry);
    }

    return {
        wants,
        services: services.map((service) => ({
            slug: service.slug,
            publisher: service.publisher,
            name: service.name,
            status: service.status,
            creditsPerRun: service.creditsPerRun,
            owned: service.userId !== null,
            servedRuns: servedOf.get(service.id) ?? 0,
            runs7d: weekOf.get(service.id)?.runs ?? 0,
            refunds7d: weekOf.get(service.id)?.refunds ?? 0,
            canaryFails: service.canaryFails,
            probedAt: service.probedAt?.toISOString() ?? null,
            suspendedFor: service.suspendedFor,
        })),
        thresholds: {
            graduationRuns: config.pool.graduationRuns,
            watchWindowRuns: config.pool.watchWindowRuns,
            maxRefundRate: config.pool.maxRefundRate,
            canaryFailures: config.pool.canaryFailures,
        },
        creators: {
            publishers,
            payoutEnabled: payoutAccounts,
            pendingPayoutCents: pendingPayouts._sum.amountCents ?? 0,
            unclaimedCents: unclaimed._sum.amountCents ?? 0,
        },
    };
};
