import type { Config } from "../config.js";

/* THE POOL MATH — a pure function from ledger rows to the numbers the transparency endpoint publishes, kept
 * free of Prisma and Hono so the arithmetic the whole promise rests on is testable in one line of setup.
 *
 * The unit is the CREDIT, everywhere. A member's credits are the only currency the platform itself meters —
 * sandboxes are self-hosted, so any usage signal they sent could be invented, and none is asked for. What
 * earns instead is what demonstrably passed through the platform's hands: a credit DONATED to a non-service
 * extension at install/update time, or a credit CONSUMED by a metered service run. Each spent credit pays
 * its recipient a published share of its dollar value; credits nobody spends pay nobody, so the pool figure
 * is a ceiling the payouts approach, never a promise that outruns actual use.
 *
 * That construction is also the sybil defense. A member's credits are bounded by their own membership
 * (30 × dailyCredits ≈ exactly what they paid), so a creator "farming" donations to their own listing with
 * bought memberships can only ever redirect a SHARE of money they themselves paid in — farming is
 * loss-making by arithmetic, not by policy. Policy (delisting) remains for nudging real users into
 * meaningless updates, and the monthly donation dedupe bounds even that at twelve donations per install
 * per year. */

// One credit's value in cents, derived from the published numbers rather than configured separately, so the
// three figures (price, allowance, credit value) cannot disagree: a month's allowance is 30 × dailyCredits.
export const creditCents = (config: Config): number => (config.pool.priceUsd * 100) / (30 * config.pool.dailyCredits);

// A month's donations to one extension, already aggregated (the route sums; this prices).
export interface DonationAggregate {
    readonly extensionId: string;
    // Distinct donating installs this month.
    readonly donors: number;
    readonly credits: number;
}

// A month's served runs for one service, already aggregated.
export interface ServiceAggregate {
    readonly slug: string;
    readonly publisher: string;
    readonly runs: number;
    readonly credits: number;
}

export interface ExtensionEarnings extends DonationAggregate {
    // credits × credit value × creatorShare, floored to whole cents.
    readonly earningsCents: number;
}

export interface ServiceEarnings extends ServiceAggregate {
    // credits × credit value × serviceShare, floored to whole cents.
    readonly earningsCents: number;
}

export interface MonthReport {
    readonly month: string;
    readonly members: number;
    // members × priceUsd, in cents.
    readonly grossCents: number;
    readonly creatorShare: number;
    readonly serviceShare: number;
    // grossCents × creatorShare — the ceiling payouts approach as members actually spend their credits.
    readonly poolCents: number;
    // What this month's spent credits actually earned, both kinds together. Always ≤ poolCents when every
    // member's spend is bounded by their allowance — by arithmetic, not by a cap.
    readonly paidCents: number;
    readonly extensions: readonly ExtensionEarnings[];
    readonly services: readonly ServiceEarnings[];
}

export const computeMonth = (
    month: string,
    members: number,
    config: Config,
    donationAggregates: readonly DonationAggregate[] = [],
    serviceAggregates: readonly ServiceAggregate[] = [],
): MonthReport => {
    const grossCents = Math.round(members * config.pool.priceUsd * 100);
    const poolCents = Math.round(grossCents * config.pool.creatorShare);
    const extensions = donationAggregates
        .map((aggregate) => ({ ...aggregate, earningsCents: Math.floor(aggregate.credits * creditCents(config) * config.pool.creatorShare) }))
        // Largest slice first — the order every reader wants, and a stable tiebreak so the page never jitters.
        .toSorted((a, b) => b.credits - a.credits || a.extensionId.localeCompare(b.extensionId));
    const services = serviceAggregates
        .map((aggregate) => ({ ...aggregate, earningsCents: Math.floor(aggregate.credits * creditCents(config) * config.pool.serviceShare) }))
        .toSorted((a, b) => b.credits - a.credits || a.slug.localeCompare(b.slug));
    const paidCents = [...extensions, ...services].reduce((sum, row) => sum + row.earningsCents, 0);
    return {
        month,
        members,
        grossCents,
        creatorShare: config.pool.creatorShare,
        serviceShare: config.pool.serviceShare,
        poolCents,
        paidCents,
        extensions,
        services,
    };
};
