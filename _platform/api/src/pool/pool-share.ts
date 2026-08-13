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
 * per year.
 *
 * WHAT THE POOL IS A SHARE OF: the membership MINUS the per-member cost of running the platform
 * (`pool.infraUsd` — a member's hosted machine and its disk, above all), not the whole ticket. Levied on
 * gross, the shares left the platform ~$2 of a $20 membership whose holder spent their whole allowance,
 * while that same member cost more than that to host — so the harder someone used the product, the worse the
 * platform did, which is not a shape any amount of growth improves.
 *
 * Taking it off the top FIRST is what keeps the published share literally true of the thing it names: 90% of
 * the pool really is 90% of the pool. The alternative — paying 90% of a "membership" that quietly isn't —
 * would be the sort of asterisk this model exists in order not to have, which is also why the report below
 * carries `infraCents` as its own line rather than folding it into a smaller gross. */

/* One credit's value in cents, derived from the published numbers rather than configured separately, so the
 * figures (price, infrastructure, allowance, credit value) cannot disagree: a month's allowance is
 * 30 × dailyCredits, and what backs it is the POOL — the membership after infrastructure — because that is
 * the money a spent credit can actually direct. Pricing a credit off the full ticket instead would promise
 * every member the power to send more away than their membership contributes. */
export const poolUsd = (config: Config): number => Math.max(0, config.pool.priceUsd - config.pool.infraUsd);

export const creditCents = (config: Config): number => (poolUsd(config) * 100) / (30 * config.pool.dailyCredits);

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
    // members × infraUsd, in cents — what running the platform for these members costs, taken off the top
    // before any share is computed. Its own line rather than a quietly smaller gross: a reader can only check
    // the share if they can see both numbers it sits between.
    readonly infraCents: number;
    readonly creatorShare: number;
    readonly serviceShare: number;
    // (grossCents − infraCents) × creatorShare — the ceiling payouts approach as members actually spend their
    // credits.
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
    // Infrastructure comes off the top; the shares are levied on what is left. Clamped at the gross so a
    // misconfigured infraUsd above the price can only ever produce an empty pool, never a negative one that
    // would read as creators owing money.
    const infraCents = Math.min(grossCents, Math.round(members * config.pool.infraUsd * 100));
    const poolCents = Math.round((grossCents - infraCents) * config.pool.creatorShare);
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
        infraCents,
        creatorShare: config.pool.creatorShare,
        serviceShare: config.pool.serviceShare,
        poolCents,
        paidCents,
        extensions,
        services,
    };
};
