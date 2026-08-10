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
    // grossCents × creatorShare — what the creators split.
    readonly poolCents: number;
    readonly memberActiveDays: number;
    // Active-days from non-members — shown, not paid.
    readonly otherActiveDays: number;
    readonly extensions: readonly ExtensionShare[];
}

export const computeMonth = (month: string, rows: readonly UseDayRow[], memberIds: ReadonlySet<string>, members: number, config: Config): MonthReport => {
    const memberRows = rows.filter((row) => memberIds.has(row.userId));
    const byExtension = new Map<string, number>();
    for (const row of memberRows) {
        byExtension.set(row.extensionId, (byExtension.get(row.extensionId) ?? 0) + 1);
    }
    const grossCents = Math.round(members * config.pool.priceUsd * 100);
    const poolCents = Math.round(grossCents * config.pool.creatorShare);
    const total = memberRows.length;
    const extensions = [...byExtension.entries()]
        .map(([extensionId, activeDays]) => ({
            extensionId,
            activeDays,
            share: total === 0 ? 0 : activeDays / total,
            amountCents: total === 0 ? 0 : Math.floor((poolCents * activeDays) / total),
        }))
        // Largest slice first — the order every reader wants, and a stable tiebreak so the page never jitters.
        .toSorted((a, b) => b.activeDays - a.activeDays || a.extensionId.localeCompare(b.extensionId));
    return {
        month,
        members,
        grossCents,
        creatorShare: config.pool.creatorShare,
        poolCents,
        memberActiveDays: total,
        otherActiveDays: rows.length - total,
        extensions,
    };
};
