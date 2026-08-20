import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { isPremium } from "./pool-membership.js";
import { computeMonth, type DonationAggregate, type ServiceAggregate } from "./pool-share.js";
import type { StripeGateway } from "./pool-stripe.js";

/* CLOSING A MONTH, turning a figure that moves into one that can be paid.
 *
 * The public ledger recomputes itself from the donation and run rows on every read. That is right for a month
 * in progress and useless for settlement twice over: a number that changes cannot be agreed on, and the rows
 * behind it are swept at thirteen months (retention.ts), after which nothing would remain to say what was owed.
 * The close reads the ledger ONCE, prices it with the same arithmetic the live page uses (pool-share.ts, so the
 * two can never drift), and writes the result down for good.
 *
 * Three things are frozen besides the money. The SHARES, so a closed month keeps paying by the number that was
 * published while it was open rather than whatever is configured later. The MEMBER COUNT, which the live page
 * already states is a snapshot. And the PAYABLE DATE, so a creator reads a date instead of "soon".
 *
 * What is deliberately NOT frozen is who gets paid. Statements are per publisher name; who that name belongs to
 * is the claim table's answer at payout time, so a creator who proves a name in October is still paid for July
 * without a single frozen row being rewritten. */

// Cents distributed to a publisher for a closed month, before anyone is identified.
interface Share {
    readonly publisher: string;
    readonly amountCents: number;
    readonly credits: number;
}

// `publisher.name` → `publisher`. Extension earnings accrue against the full extension id; a payout is owed to
// the publisher behind it.
const publisherOf = (extensionId: string): string => extensionId.split(`.`)[0] ?? extensionId;

// The UTC half-open window of a "YYYY-MM" month: [first instant, first instant of the next month).
export const monthWindow = (month: string): { from: Date; to: Date } => {
    const from = new Date(`${month}-01T00:00:00.000Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    return { from, to };
};

// The most recent month that is entirely in the past, the only one there is anything to close.
export const lastClosableMonth = (now: Date): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

/* Fold every listing's earnings into one line per publisher. A publisher earning through both lanes, an
 * extension people install and a service they run, is owed one amount, not two rows that a payout would then
 * have to remember to add up. */
const sharesOf = (
    extensions: readonly { extensionId: string; earningsCents: number; credits: number }[],
    services: readonly { publisher: string; earningsCents: number; credits: number }[],
): Share[] => {
    const byPublisher = new Map<string, { amountCents: number; credits: number }>();
    const add = (publisher: string, amountCents: number, credits: number): void => {
        const previous = byPublisher.get(publisher);
        byPublisher.set(publisher, { amountCents: (previous?.amountCents ?? 0) + amountCents, credits: (previous?.credits ?? 0) + credits });
    };
    for (const row of extensions) {
        add(publisherOf(row.extensionId), row.earningsCents, row.credits);
    }
    for (const row of services) {
        add(row.publisher, row.earningsCents, row.credits);
    }
    return [...byPublisher.entries()]
        .map(([publisher, totals]) => ({ publisher, ...totals }))
        .toSorted((a, b) => b.amountCents - a.amountCents || a.publisher.localeCompare(b.publisher));
};

/* Spread returned money across this month's earners in proportion to what they earned, by largest remainder so
 * the parts add up to the whole. Plain proportional rounding would leave stray cents that belong to nobody, and
 * a distribution whose lines do not sum to its total is exactly the arithmetic this system publishes to prove
 * it does not do. */
export const distribute = (total: number, shares: readonly Share[]): readonly number[] => {
    const basis = shares.reduce((sum, share) => sum + share.amountCents, 0);
    if (total <= 0 || basis <= 0) {
        return shares.map(() => 0);
    }
    const exact = shares.map((share) => (share.amountCents * total) / basis);
    const floors = exact.map((value) => Math.floor(value));
    let remaining = total - floors.reduce((sum, value) => sum + value, 0);
    // Biggest fractional part first; ties by the order above, which is already deterministic.
    const order = exact
        .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
        .toSorted((a, b) => b.fraction - a.fraction || a.index - b.index);
    const result = [...floors];
    for (const { index } of order) {
        if (remaining <= 0) {
            break;
        }
        result[index] = (result[index] ?? 0) + 1;
        remaining -= 1;
    }
    return result;
};

export interface CloseOutcome {
    readonly month: string;
    readonly closed: boolean;
    // Why nothing happened, when nothing did, logged, so a month that never closes is never silent.
    readonly reason?: string;
    readonly statements?: number;
    readonly distributedCents?: number;
    readonly sweptCents?: number;
}

export interface CloseDeps {
    readonly prisma: PrismaClient;
    readonly config: Config;
    readonly gateway: StripeGateway;
    readonly now?: () => Date;
}

/* Close one month, once. Re-running is a no-op rather than a second close, the job ticks daily and a closed
 * month must never be rewritten, least of all with a member count or a share that has moved since. */
export const closeMonth = async (month: string, { prisma, config, gateway, now = () => new Date() }: CloseDeps): Promise<CloseOutcome> => {
    const at = now();
    if ((await prisma.poolMonth.findUnique({ where: { month }, select: { id: true } })) !== null) {
        return { month, closed: false, reason: `already closed` };
    }
    const { from, to } = monthWindow(month);
    const [donations, runs, memberships] = await Promise.all([
        prisma.donation.findMany({ where: { month }, select: { extensionId: true, credits: true } }),
        prisma.serviceRun.findMany({
            where: { status: `ok`, createdAt: { gte: from, lt: to } },
            select: { credits: true, service: { select: { slug: true, publisher: true } } },
        }),
        prisma.membership.findMany({ select: { status: true } }),
    ]);

    /* The settled revenue read is what a closed month publishes instead of members × price, so a failure here
     * ABORTS the close rather than falling back to the estimate. A month that closes late is a delay; a month
     * that closes with an invented revenue figure is a wrong number on the page whose whole job is being
     * checkable, and it can never be corrected without unfreezing a settled month. */
    let settled;
    try {
        settled = await gateway.settledRevenue({ from, to });
    } catch (error) {
        return { month, closed: false, reason: `settled revenue unreadable: ${error instanceof Error ? error.message : String(error)}` };
    }

    const donationAggregates = new Map<string, DonationAggregate>();
    for (const donation of donations) {
        const previous = donationAggregates.get(donation.extensionId);
        donationAggregates.set(donation.extensionId, {
            extensionId: donation.extensionId,
            donors: (previous?.donors ?? 0) + 1,
            credits: (previous?.credits ?? 0) + donation.credits,
        });
    }
    const serviceAggregates = new Map<string, ServiceAggregate>();
    for (const run of runs) {
        const previous = serviceAggregates.get(run.service.slug);
        serviceAggregates.set(run.service.slug, {
            slug: run.service.slug,
            publisher: run.service.publisher,
            runs: (previous?.runs ?? 0) + 1,
            credits: (previous?.credits ?? 0) + run.credits,
        });
    }
    const members = memberships.filter((membership) => isPremium(membership)).length;
    // Priced by the same function the live ledger uses, one arithmetic, so the frozen month and the open page
    // can never state different numbers for the same spend.
    const report = computeMonth(month, members, config, [...donationAggregates.values()], [...serviceAggregates.values()]);
    const shares = sharesOf(report.extensions, report.services);

    /* Money whose twelve months ran out, returned to the people still shipping. Only UNCLAIMED statements
     * expire: an amount owed to a creator who proved their name is owed until it is paid, however long that
     * takes. And the sweep only happens into a month that HAS earners, with nobody to receive it the money
     * would simply vanish, so it stays claimable and is swept by the next close that can distribute it. */
    const claimedPublishers = new Set((await prisma.publisherClaim.findMany({ select: { publisher: true } })).map((claim) => claim.publisher));
    const expired =
        shares.length === 0
            ? []
            : (
                  await prisma.creatorStatement.findMany({
                      where: { expiredAt: null, expiresAt: { lte: at } },
                      select: { id: true, publisher: true, amountCents: true },
                  })
              ).filter((statement) => !claimedPublishers.has(statement.publisher));
    const sweptCents = expired.reduce((sum, statement) => sum + statement.amountCents, 0);
    const sweptShares = distribute(sweptCents, shares);

    const expiresAt = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + config.pool.claimWindowMonths, 1));
    // The month after the one being closed, on the published payout day: July closes in August and pays in
    // August, which is the cadence the site states.
    const payableAt = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), config.pool.payoutDayOfMonth));
    const rows = shares.map((share, index) => ({
        month,
        publisher: share.publisher,
        amountCents: share.amountCents + (sweptShares[index] ?? 0),
        credits: share.credits,
        expiresAt,
    }));
    const distributedCents = rows.reduce((sum, row) => sum + row.amountCents, 0);

    /* One transaction: the month, its statements, and the retirement of what was swept into them. A close that
     * half-happened would either pay money twice or lose it, and both are unrecoverable once the ledger rows
     * behind them age out. */
    await prisma.$transaction([
        prisma.poolMonth.create({
            data: {
                month,
                members,
                grossCents: settled.grossCents,
                feeCents: settled.feeCents,
                infraCents: report.infraCents,
                poolCents: report.poolCents,
                earnedCents: report.paidCents,
                sweptCents,
                distributedCents,
                creatorShare: config.pool.creatorShare,
                serviceShare: config.pool.serviceShare,
                payableAt,
            },
        }),
        ...(rows.length > 0 ? [prisma.creatorStatement.createMany({ data: rows })] : []),
        ...(expired.length > 0
            ? [prisma.creatorStatement.updateMany({ where: { id: { in: expired.map((row) => row.id) } }, data: { expiredAt: at } })]
            : []),
    ]);
    return { month, closed: true, statements: rows.length, distributedCents, sweptCents };
};

/* The daily tick's work: close every month that is over and still open, oldest first. Catching up rather than
 * closing only last month matters because a platform that was down, or newly deployed, must not silently skip a
 * month, and each close is independent, so an unreadable Stripe month blocks itself and nothing else. */
export const closeDueMonths = async (deps: CloseDeps, logger: Logger, horizonMonths = 13): Promise<readonly CloseOutcome[]> => {
    const at = (deps.now ?? (() => new Date()))();
    const outcomes: CloseOutcome[] = [];
    for (let shift = horizonMonths; shift >= 1; shift -= 1) {
        const month = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - shift, 1)).toISOString().slice(0, 7);
        const outcome = await closeMonth(month, deps);
        if (outcome.closed) {
            logger.info(outcome, `pool: month closed`);
            outcomes.push(outcome);
        } else if (outcome.reason !== `already closed`) {
            logger.warn(outcome, `pool: month not closed`);
            outcomes.push(outcome);
        }
    }
    return outcomes;
};
