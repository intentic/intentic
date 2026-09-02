import { oc } from "@orpc/contract";
import { z } from "zod";
import { DayWindowQuerySchema, UsageRollupSchema } from "../schemas/usage.js";

// The one control over the headroom readings a person has: measure again, now, every connection. `force`
// ignores the freshness the daemon otherwise honours (a reading from the last minute is what the provider
// would answer again), because the person pressing it has just changed something about an account and is
// asking whether what they can see survived it.
export const RefreshPlanLimitsSchema = z.object({
    force: z.boolean().default(false).describe("Measure again even if a reading was taken a moment ago."),
});

// The durable spend ledger (see UsageTurnSchema). Read-only over the wire, rows are appended daemon-side at
// turn end, so the ledger stays a trustworthy record of what was actually spent, the same principle as the
// activity log. `rollup` serves every cost/usage panel: it groups by day × provider × account × model, and the
// browser re-projects from there (spend per day, cost by model, cache hit rate) without another round trip.
export const usageContract = {
    rollup: oc
        .route({
            method: "GET",
            path: "/usage/rollup",
            summary: "What was spent, grouped",
            description:
                "The spending record over a range of days, grouped by day, provider, account and model. Everything a cost screen shows is a rearrangement of this one answer, so nothing needs a second call. Read-only: rows are written by the sandbox as turns end, which is what makes it worth trusting.",
        })
        .input(DayWindowQuerySchema)
        .output(UsageRollupSchema),
    // Not the ledger's business, but the same tab: the plan-limit readings behind every ring, re-measured on
    // request for every provider at once. The readings themselves arrive on /events as they land, and on the
    // account lists afterwards; this answers once the sweep is done or its deadline passes.
    refreshPlanLimits: oc
        .route({
            method: "POST",
            path: "/usage/plan-limits/refresh",
            summary: "Measure every account's plan limits again",
            description:
                "Reads how full each connected account's plan limits are, for every provider, and records it. Forced, it measures even accounts read a moment ago, which is the right thing when a plan was just changed and the question is whether the number on screen is still true.",
        })
        .input(RefreshPlanLimitsSchema)
        .output(z.object({ ok: z.literal(true) })),
};
