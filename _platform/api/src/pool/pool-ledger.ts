import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import { isPremium } from "./pool-membership.js";
import { computeMonth, type DonationAggregate, type ServiceAggregate } from "./pool-share.js";

/* THE PUBLIC LEDGER, the promise this whole system is built to make checkable, served to anyone with no login.
 *
 * It publishes two KINDS of month and never lets them be mistaken for each other. An OPEN month is computed
 * live from the ledger rows and its revenue is an estimate (members × price), because nobody can know what a
 * month took until it is over; every figure on it can still move. A CLOSED month is the frozen record: revenue
 * is what actually settled at Stripe, fees included, and none of it will ever change again.
 *
 * That distinction is the honest part. The older version of this endpoint published one shape for every month
 * and stated members × price as "gross revenue" throughout, which reads as a fact and is an extrapolation. A
 * reader can now see which numbers are settled and which are still moving, and the two are labelled rather
 * than left to be inferred.
 *
 * WHAT HAPPENED TO THE MONEY is published too, per closed month: paid, in flight, carried (owed to a creator
 * but not yet sent, under the minimum, or not yet due), unclaimed (owed to a publisher name nobody has proved
 * yet) and expired (unclaimed past its window and returned to a later month's pool). Publishing only the total
 * earned would let "we pay 90%" hide an arbitrary amount of money that never actually reached anybody. */

// How many closed months to serve. Thirteen matches the ledger retention behind them: a full year of history
// plus the month in progress.
const CLOSED_MONTHS = 13;

// "2026-08" for the month `shift` months before the one `at` falls in.
const monthShifted = (at: Date, shift: number): string =>
    new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - shift, 1)).toISOString().slice(0, 7);

// What became of one frozen line. Derived, never stored: who a name belongs to can change after a close, so a
// status written into the row would go stale the moment somebody claimed it.
type LineStatus = `paid` | `pending` | `carried` | `unclaimed` | `expired`;

const statusOf = (
    statement: { expiredAt: Date | null; payout: { status: string } | null },
    claimed: ReadonlySet<string>,
    publisher: string,
): LineStatus => {
    if (statement.expiredAt !== null) {
        return `expired`;
    }
    if (statement.payout !== null) {
        return statement.payout.status === `paid` ? `paid` : `pending`;
    }
    return claimed.has(publisher) ? `carried` : `unclaimed`;
};

export const buildLedger = async (prisma: PrismaClient, config: Config, at: Date) => {
    const openMonth = monthShifted(at, 0);
    const [donations, runs, memberships, closedMonths, claims] = await Promise.all([
        prisma.donation.findMany({ where: { month: openMonth }, select: { extensionId: true, credits: true } }),
        // Only served runs earn, a refunded run charged nobody and pays nobody.
        prisma.serviceRun.findMany({
            where: { status: `ok`, createdAt: { gte: new Date(`${openMonth}-01T00:00:00.000Z`) } },
            select: { credits: true, service: { select: { slug: true, publisher: true } } },
        }),
        prisma.membership.findMany({ select: { status: true } }),
        prisma.poolMonth.findMany({
            orderBy: { month: `desc` },
            take: CLOSED_MONTHS,
            include: {
                statements: {
                    orderBy: { amountCents: `desc` },
                    select: { publisher: true, amountCents: true, credits: true, expiredAt: true, payout: { select: { status: true } } },
                },
            },
        }),
        prisma.publisherClaim.findMany({ select: { publisher: true } }),
    ]);
    const claimed = new Set(claims.map((claim) => claim.publisher));

    const byExtension = new Map<string, DonationAggregate>();
    for (const donation of donations) {
        const previous = byExtension.get(donation.extensionId);
        byExtension.set(donation.extensionId, {
            extensionId: donation.extensionId,
            donors: (previous?.donors ?? 0) + 1,
            credits: (previous?.credits ?? 0) + donation.credits,
        });
    }
    const byService = new Map<string, ServiceAggregate>();
    for (const run of runs) {
        const previous = byService.get(run.service.slug);
        byService.set(run.service.slug, {
            slug: run.service.slug,
            publisher: run.service.publisher,
            runs: (previous?.runs ?? 0) + 1,
            credits: (previous?.credits ?? 0) + run.credits,
        });
    }
    const members = memberships.filter((membership) => isPremium(membership)).length;
    const live = computeMonth(openMonth, members, config, [...byExtension.values()], [...byService.values()]);

    /* The month in progress. `estimatedGrossCents` is named for exactly what it is: this month's revenue has
     * not settled, so the only figure available is members × price, and calling it "gross" like the closed
     * months do would pass an extrapolation off as a bank statement. */
    const open = {
        month: live.month,
        state: `open` as const,
        members: live.members,
        estimatedGrossCents: live.grossCents,
        // Estimated on the same basis as the gross above it, and shown for the same reason: the pool figure
        // beneath is what is left after this, and a share whose base is invisible discloses nothing.
        estimatedInfraCents: live.infraCents,
        poolCents: live.poolCents,
        earnedCents: live.paidCents,
        extensions: live.extensions,
        services: live.services,
    };

    const closed = closedMonths.map((month) => {
        const lines = month.statements.map((statement) => ({
            publisher: statement.publisher,
            amountCents: statement.amountCents,
            credits: statement.credits,
            status: statusOf(statement, claimed, statement.publisher),
        }));
        const totalOf = (status: LineStatus): number =>
            lines.filter((line) => line.status === status).reduce((sum, line) => sum + line.amountCents, 0);
        return {
            month: month.month,
            state: `closed` as const,
            closedAt: month.closedAt.toISOString(),
            payableAt: month.payableAt.toISOString(),
            members: month.members,
            // Settled, not estimated: what actually moved at Stripe, and what Stripe took on it.
            grossCents: month.grossCents,
            feeCents: month.feeCents,
            // What the platform's own infrastructure took off the top before the shares below were computed.
            // Published for the same reason the share itself is: a percentage nobody can see the base of is
            // not a disclosure.
            infraCents: month.infraCents,
            creatorShare: month.creatorShare,
            serviceShare: month.serviceShare,
            poolCents: month.poolCents,
            earnedCents: month.earnedCents,
            // Money returned from months whose unclaimed window ran out, folded into this month's split.
            sweptCents: month.sweptCents,
            distributedCents: month.distributedCents,
            paidCents: totalOf(`paid`),
            pendingCents: totalOf(`pending`),
            carriedCents: totalOf(`carried`),
            unclaimedCents: totalOf(`unclaimed`),
            expiredCents: totalOf(`expired`),
            creators: lines,
        };
    });

    return {
        priceUsd: config.pool.priceUsd,
        creatorShare: config.pool.creatorShare,
        serviceShare: config.pool.serviceShare,
        dailyCredits: config.pool.dailyCredits,
        donationCredits: config.pool.donationCredits,
        // The payout rules, published beside the numbers they produce, so the page explaining them and the
        // platform applying them cannot quietly disagree.
        payoutDayOfMonth: config.pool.payoutDayOfMonth,
        minPayoutCents: config.pool.minPayoutCents,
        claimWindowMonths: config.pool.claimWindowMonths,
        months: [open, ...closed],
    };
};
