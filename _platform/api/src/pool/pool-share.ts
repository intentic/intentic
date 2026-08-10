import type { Config } from "../config.js";

/* THE POOL MATH — a pure function from ledger rows to the numbers the transparency endpoint publishes, kept
 * free of Prisma and Hono so the arithmetic the whole promise rests on is testable in one line of setup.
 *
 * The unit is the MEMBER ACTIVE-DAY: one member's sandbox used one premium extension on one day. An
 * extension's share of a month is its share of all member active-days that month; the pool it takes that
 * share of is members × price × creatorShare. Rows from non-members are counted separately and paid nothing
 * — free-tier use is visible (creators can see demand) but only revenue-backed use divides revenue. */

export interface UseDayRow {
    readonly extensionId: string;
    readonly userId: string;
}

// One credit's value in cents, derived from the published numbers rather than configured separately, so the
// three figures (price, allowance, credit value) cannot disagree: a month's allowance is 30 × dailyCredits.
export const creditCents = (config: Config): number => (config.pool.priceUsd * 100) / (30 * config.pool.dailyCredits);

// A month's served runs for one service, already aggregated (the route sums; this prices).
export interface ServiceAggregate {
    readonly slug: string;
    readonly publisher: string;
    readonly runs: number;
    readonly credits: number;
}

export interface ServiceEarnings extends ServiceAggregate {
    // credits × credit value × serviceShare, floored to whole cents.
    readonly earningsCents: number;
}

export const computeServiceEarnings = (aggregates: readonly ServiceAggregate[], config: Config): ServiceEarnings[] =>
    aggregates
        .map((aggregate) => ({ ...aggregate, earningsCents: Math.floor(aggregate.credits * creditCents(config) * config.pool.serviceShare) }))
        .toSorted((a, b) => b.credits - a.credits || a.slug.localeCompare(b.slug));

export interface ExtensionShare {
    readonly extensionId: string;
    // Member active-days this month.
    readonly activeDays: number;
    // This extension's fraction of all member active-days, 0..1.
    readonly share: number;
    // Its slice of the pool, in whole cents so the published number never carries float dust.
    readonly amountCents: number;
}

export interface MonthReport {
    readonly month: string;
    readonly members: number;
    // members × priceUsd, in cents.
    readonly grossCents: number;
    readonly creatorShare: number;
    // grossCents × creatorShare — what the creators split, services first.
    readonly poolCents: number;
    /* The settlement order, stated in the numbers themselves: services carry real upstream costs, so their
     * earnings settle out of the pool FIRST (capped at the pool — a month where metered runs outgrow the
     * pool pays services the whole pool and extensions nothing, rather than inventing money), and what
     * remains is what active-days divide. */
    readonly servicePoolCents: number;
    readonly extensionPoolCents: number;
    readonly memberActiveDays: number;
    // Active-days from non-members — shown, not paid.
    readonly otherActiveDays: number;
    readonly extensions: readonly ExtensionShare[];
    readonly services: readonly ServiceEarnings[];
}

export const computeMonth = (
    month: string,
    rows: readonly UseDayRow[],
    memberIds: ReadonlySet<string>,
    members: number,
    config: Config,
    serviceAggregates: readonly ServiceAggregate[] = [],
): MonthReport => {
    const memberRows = rows.filter((row) => memberIds.has(row.userId));
    const byExtension = new Map<string, number>();
    for (const row of memberRows) {
        byExtension.set(row.extensionId, (byExtension.get(row.extensionId) ?? 0) + 1);
    }
    const grossCents = Math.round(members * config.pool.priceUsd * 100);
    const poolCents = Math.round(grossCents * config.pool.creatorShare);
    const services = computeServiceEarnings(serviceAggregates, config);
    const servicePoolCents = Math.min(
        poolCents,
        services.reduce((sum, service) => sum + service.earningsCents, 0),
    );
    const extensionPoolCents = poolCents - servicePoolCents;
    const total = memberRows.length;
    const extensions = [...byExtension.entries()]
        .map(([extensionId, activeDays]) => ({
            extensionId,
            activeDays,
            share: total === 0 ? 0 : activeDays / total,
            amountCents: total === 0 ? 0 : Math.floor((extensionPoolCents * activeDays) / total),
        }))
        // Largest slice first — the order every reader wants, and a stable tiebreak so the page never jitters.
        .toSorted((a, b) => b.activeDays - a.activeDays || a.extensionId.localeCompare(b.extensionId));
    return {
        month,
        members,
        grossCents,
        creatorShare: config.pool.creatorShare,
        poolCents,
        servicePoolCents,
        extensionPoolCents,
        memberActiveDays: total,
        otherActiveDays: rows.length - total,
        extensions,
        services,
    };
};
