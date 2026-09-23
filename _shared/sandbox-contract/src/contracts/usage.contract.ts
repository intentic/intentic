import { procedure } from "../protocol/route-meta.js";
import { z } from "zod";
import { LimitResetClaimSchema, LimitResetStatusSchema } from "../schemas/providers/plan-limits.js";
import { DayWindowQuerySchema, UsageRollupSchema } from "../schemas/providers/usage.js";

// `force` ignores the daemon's freshness window and measures now instead of reusing a recent reading.
export const RefreshPlanLimitsSchema = z.object({
    force: z.boolean().default(false).describe("Measure again even if a reading was taken a moment ago."),
});

// What a re-measure could not read. A provider rate-limits these reads per account, and while it is holding one off
// the number on screen cannot move: without this the caller can only report a press that changed nothing.
export const PlanLimitsRefreshedSchema = z.object({
    ok: z.literal(true),
    held: z
        .array(
            z.object({
                provider: z.string().describe("Which provider is holding the read off."),
                account: z.string().describe("The account as its provider's list names it: an account id, or a routed auth file's name."),
                resumesAt: z.number().describe("Unix seconds: when this account may be read again, the provider's own retry-after."),
            }),
        )
        .describe("Accounts whose plan limits could not be read now because the provider is rate-limiting them."),
});
export type PlanLimitsRefreshed = z.infer<typeof PlanLimitsRefreshedSchema>;
export type PlanLimitsHeld = PlanLimitsRefreshed["held"][number];

// Durable spend ledger, read-only over the wire; rows are appended daemon-side at turn end.
// `rollup` groups by day, provider, account and model, so every cost panel re-projects from this one answer.
export const usageContract = {
    rollup: procedure
        .route({
            method: "GET",
            path: "/usage/rollup",
            summary: "What was spent, grouped",
            description:
                "The spending record over a range of days, grouped by day, provider, account and model. Everything a cost screen shows is a rearrangement of this one answer, so nothing needs a second call. Read-only: rows are written by the sandbox as turns end, which is what makes it worth trusting.",
        })
        .input(DayWindowQuerySchema)
        .output(UsageRollupSchema),
    // Re-measures every account's plan limits on request; readings also arrive via /events and account lists otherwise.
    refreshPlanLimits: procedure
        .route({
            method: "POST",
            path: "/usage/plan-limits/refresh",
            summary: "Measure every account's plan limits again",
            description:
                "Reads how full each connected account's plan limits are, for every provider, and records it. Forced, it measures even accounts read a moment ago, which is the right thing when a plan was just changed and the question is whether the number on screen is still true. Answers with the accounts it could not read because the provider is rate-limiting them, and when each may be asked again: those keep the reading they already had, so a number that does not move is explained rather than silent.",
        })
        .input(RefreshPlanLimitsSchema)
        .output(PlanLimitsRefreshedSchema),
    // Asked, not polled: the provider only evaluates this when told the account is at the wall, and the answer isn't
    // cached.
    // Answers `available: false` rather than failing when the account has no such mechanism.
    limitReset: procedure
        .route({
            method: "GET",
            path: "/usage/limit-reset/{account}",
            summary: "Whether this account's session window can be reopened now",
            description:
                "Asks the provider whether it will reopen this account's spent session window immediately, which some plans grant once a week. Only worth asking about an account that has actually been refused: the answer is the provider's judgement at this moment, it is not cached, and an account with no such grant answers plainly that it has none.",
        })
        .input(z.object({ account: z.string().min(1).describe("Which account.") }))
        .output(LimitResetStatusSchema),
    claimLimitReset: procedure
        .route({
            method: "POST",
            path: "/usage/limit-reset/{account}/claim",
            summary: "Reopen this account's session window now",
            description:
                "Spends one of the account's weekly resets to reopen its session window immediately. The weekly allowance is untouched and still binds. Answers with what the provider actually did: only `reset` changed anything, and it is the cue to send the refused turn again.",
        })
        .input(z.object({ account: z.string().min(1).describe("Which account.") }))
        .output(LimitResetClaimSchema),
};
