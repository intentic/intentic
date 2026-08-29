import { oc } from "@orpc/contract";
import { DayWindowQuerySchema, UsageRollupSchema } from "../schemas/usage.js";

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
};
