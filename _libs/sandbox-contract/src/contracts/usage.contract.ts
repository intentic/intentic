import { oc } from "@orpc/contract";
import { DayWindowQuerySchema, UsageRollupSchema } from "../schemas.js";

// The durable spend ledger (see UsageTurnSchema). Read-only over the wire — rows are appended daemon-side at
// turn end, so the ledger stays a trustworthy record of what was actually spent, the same principle as the
// activity log. `rollup` serves every cost/usage panel: it groups by day × provider × account × model, and the
// browser re-projects from there (spend per day, cost by model, cache hit rate) without another round trip.
export const usageContract = {
    rollup: oc.route({ method: "GET", path: "/usage/rollup" }).input(DayWindowQuerySchema).output(UsageRollupSchema),
};
