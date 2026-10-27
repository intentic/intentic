import type { UsageTurn } from "@intentic/sandbox-contract/schemas/providers/usage";
import { homeCost } from "./home-cost.js";

// A home's turns against everyone else's, off ledger rows.

const turn = (over: Partial<UsageTurn> & Pick<UsageTurn, "conversationId" | "costUsd">): UsageTurn => ({
    at: 0,
    day: "2026-10-27",
    provider: "claude",
    harness: "claude-code",
    outcome: "ok",
    turns: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    durationMs: 1,
    ...over,
});

test("splits priced turns into a home's and every other, and says how they compare", () => {
    const cost = homeCost(
        [
            turn({ conversationId: "home-a", costUsd: 2, contextTokens: 100_000 }),
            turn({ conversationId: "home-a", costUsd: 1, contextTokens: 40_000, homeFresh: "budget" }),
            turn({ conversationId: "home-a", costUsd: 9, contextTokens: 200_000 }),
            turn({ conversationId: "wise-fern", costUsd: 3 }),
            turn({ conversationId: "calm-oak", costUsd: 1 }),
            // Not a priced turn: a failure and a vendor that prices nothing.
            turn({ conversationId: "home-a", costUsd: 50, outcome: "error" }),
            turn({ conversationId: "calm-oak", costUsd: 0, costKnown: false }),
            // Before the window.
            turn({ conversationId: "home-a", costUsd: 99, day: "2026-10-01" }),
        ],
        { since: "2026-10-20", budget: 150_000 },
    );
    expect(cost.home).toMatchObject({ turns: 3, conversations: 1, costMean: 4, costP50: 2 });
    expect(cost.other).toMatchObject({ turns: 2, conversations: 2, costMean: 2 });
    expect(cost.ratio).toBe(2);
    expect(cost.fresh.byWhy).toEqual({ budget: 1 });
    expect(cost.fresh.spread.costMean).toBe(1);
    expect(cost.overBudget).toMatchObject({ turns: 1, costMean: 9 });
});

test("says nothing of a ratio until both sides have turns", () => {
    expect(homeCost([turn({ conversationId: "calm-oak", costUsd: 1 })], { budget: 150_000 }).ratio).toBeUndefined();
});
