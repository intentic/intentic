import type { UsageTurn } from "@intentic/sandbox-contract/schemas/providers/usage";
import { HOME_PREFIX } from "@intentic/sandbox-contract/ids/conversation-ids";

// WHETHER A HOME CONVERSATION COSTS WHAT AN ORDINARY ONE DOES, off the spend ledger (historyRoot/usage.jsonl, one row
// per turn). A home is one chat kept for good, so the question is per turn: a home's turn against any other's, by cost
// and by the context it ended on, and, for the turns that opened a fresh session (`homeFresh`, the daemon's
// conversations/home/home-rollover.ts), what those cost beside the home turns that resumed a session past the budget.
// Read by `bench:home` (home-cost-stats.ts); kept apart from the CLI so its test can import it.

export interface Spread {
    readonly turns: number;
    readonly conversations: number;
    readonly costMean: number;
    readonly costP50: number;
    readonly costP90: number;
    readonly contextP50: number | undefined;
    readonly contextP90: number | undefined;
}

export interface HomeCost {
    readonly from: string | undefined;
    readonly to: string | undefined;
    readonly home: Spread;
    readonly other: Spread;
    // A home's mean turn over any other's; undefined until both have turns.
    readonly ratio: number | undefined;
    // Home turns that opened fresh, by why, and what they cost.
    readonly fresh: { readonly byWhy: Readonly<Record<string, number>>; readonly spread: Spread };
    // Home turns that resumed a session already past the budget: what a rollover is there to prevent.
    readonly overBudget: Spread;
}

const quantile = (values: readonly number[], at: number): number | undefined => {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = values.toSorted((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * at)];
};

const spreadOf = (rows: readonly UsageTurn[]): Spread => {
    const costs = rows.map((row) => row.costUsd);
    const contexts = rows.flatMap((row) => (row.contextTokens === undefined ? [] : [row.contextTokens]));
    return {
        turns: rows.length,
        conversations: new Set(rows.map((row) => row.conversationId)).size,
        costMean: costs.length === 0 ? 0 : costs.reduce((sum, cost) => sum + cost, 0) / costs.length,
        costP50: quantile(costs, 0.5) ?? 0,
        costP90: quantile(costs, 0.9) ?? 0,
        contextP50: quantile(contexts, 0.5),
        contextP90: quantile(contexts, 0.9),
    };
};

// Turns that ran and were priced: a failure, a refusal or a vendor that prices nothing says nothing about cost.
const priced = (row: UsageTurn): boolean => row.outcome === "ok" && row.costKnown !== false && row.conversationId !== undefined;

/** The ledger's turns since `since` (a YYYY-MM-DD day, inclusive), split into a home's and everyone else's. */
export const homeCost = (rows: readonly UsageTurn[], options: { readonly since?: string; readonly budget: number }): HomeCost => {
    const kept = rows.filter((row) => priced(row) && (options.since === undefined || row.day >= options.since));
    const home = kept.filter((row) => row.conversationId?.startsWith(HOME_PREFIX) === true);
    const other = kept.filter((row) => row.conversationId?.startsWith(HOME_PREFIX) !== true);
    const fresh = home.filter((row) => row.homeFresh !== undefined);
    const byWhy: Record<string, number> = {};
    for (const row of fresh) {
        byWhy[row.homeFresh ?? ""] = (byWhy[row.homeFresh ?? ""] ?? 0) + 1;
    }
    // A turn's context is where it ended; one that started past the budget is the one before it that ended there.
    const overBudget = home.filter((row) => row.homeFresh === undefined && (row.contextTokens ?? 0) >= options.budget);
    const homeSpread = spreadOf(home);
    const otherSpread = spreadOf(other);
    const days = kept.map((row) => row.day).toSorted();
    return {
        from: days[0],
        to: days.at(-1),
        home: homeSpread,
        other: otherSpread,
        ratio: homeSpread.turns === 0 || otherSpread.turns === 0 || otherSpread.costMean === 0 ? undefined : homeSpread.costMean / otherSpread.costMean,
        fresh: { byWhy, spread: spreadOf(fresh) },
        overBudget: spreadOf(overBudget),
    };
};
