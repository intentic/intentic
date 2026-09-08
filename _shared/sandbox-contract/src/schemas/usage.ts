// Durable spend ledger: per-account token and cost totals.
import { z } from "zod";
// One row per attributed turn, appended at turn end and never pruned, unlike the activity log which shrinks as it
// prunes. Rollups project this on read, so a new grouping needs no new storage.
export const UsageTurnSchema = z.object({
    // Epoch ms when the turn ended; kept alongside `day` so a timezone-aware rollup needs no data migration.
    at: z.number().describe("When the turn ended, in milliseconds."),
    // UTC calendar day (YYYY-MM-DD) `at` fell in, precomputed so rollups skip timezone arithmetic.
    day: z.string().describe("The day it fell in, as YYYY-MM-DD in UTC, worked out once so nothing downstream has to do timezone arithmetic."),
    provider: z.string().describe("Which model provider served it."),
    // Absent on an env-token turn, which has no account to attribute to.
    account: z.string().optional().describe("Which account paid. Absent for a turn run on a plain key, which belongs to no account."),
    // The model that actually ran, past the pick and every default; absent only when an unnamed default served it.
    model: z
        .string()
        .optional()
        .describe(
            "The model that actually ran, past whatever was asked for and every default. Absent only when the provider's own default served it without being named.",
        ),
    // What was asked for, distinct from `model` (what ran); differs when something resolved or substituted it.
    modelRequested: z
        .string()
        .optional()
        .describe("The model that was asked for, when one was named. Differs from `model` when something resolved it."),
    harness: z.string().describe("Which agentic loop it ran on."),
    // cancelled: the user pressed Stop, not a failure.
    // error: the provider or request killed the turn.
    // Absent means the row predates recording, not that the turn succeeded.
    outcome: z.enum(["ok", "error", "cancelled"]).optional().describe("How it ended: finished, failed, or was stopped by the user."),
    // The failing frame's code (e.g. rate_limit, provider-outage); absent even on error means unclassified.
    errorCode: z.string().optional().describe("The failure's code, when it had one."),
    // The failing frame's own sentence, capped at ERROR_MESSAGE_CHARS.
    errorMessage: z.string().optional().describe("What the failure said, trimmed."),
    // Which conversation this turn belonged to; absent only for an internal one-shot with no conversation.
    conversationId: z
        .string()
        .optional()
        .describe(
            "Which conversation it belonged to, so spending can be traced to a card. Absent only for an internal one-off with no conversation at all.",
        ),
    // The provider's own count for the request, since one exchange can be several; 1 when unreported.
    turns: z
        .number()
        .describe("The provider's own count for the request, since one exchange can be several under the hood. One when it reported none."),
    inputTokens: z.number().describe("Tokens sent."),
    outputTokens: z.number().describe("Tokens received."),
    cacheReadTokens: z.number().describe("Tokens served from cache, which cost less."),
    cacheCreationTokens: z.number().describe("Tokens written to cache, which cost more up front and less afterwards."),
    costUsd: z.number().describe("What it cost, in dollars."),
    durationMs: z.number().describe("How long it took, in milliseconds."),
    // Arm of the search-teaching experiment; stable per conversation. Absent means unmeasured.
    iqSearchArm: z.boolean().optional(),
    // Hash of the plugin nudge and skill body for this arm; recorded on control turns too, for report pairing.
    iqSearchCohort: z.string().optional(),
    // Every tool call that searched, including CLI searches like `iq q`; absent means unmeasured, not zero.
    searchCalls: z.number().optional(),
    // Search calls before the first file touch; absent as searchCalls; a turn touching nothing counts them all.
    openingSearches: z.number().optional(),
    // Directory listings (ls, tree, LS tool) before the turn's first file touch, same window as openingSearches.
    openingListings: z.number().optional(),
    // Tool calls before the turn first touched a file it later edited; absent (not zero) if it edited nothing.
    callsBeforeTarget: z.number().optional(),
    // Arm of the project-map experiment, stable per conversation; mapChars is the note's length when sent.
    mapArm: z.boolean().optional(),
    mapChars: z.number().optional(),
    // Zero-based turn count in its conversation; 0 marks the opening turn. Absent means unmeasured.
    turnIndex: z.number().optional(),
    // outcome alone can't tell a turn that finished from one that stopped talking; these fields carry the difference
    // instead of a single stop-reason word.
    // verification: verified/failing (check passed/failed after the last edit), unproven (nothing ran), no-code
    // (nothing editable changed). Folded from tool-call frames, subagents included.
    // check: the command that spoke, so a targeted test is never read as the whole suite.
    // filesEdited: every file written, prose included; verification speaks only about code.
    verification: z.enum(["verified", "unproven", "failing", "no-code"]).optional(),
    check: z.string().optional(),
    filesEdited: z.number().optional(),
    // The agent's own checklist at turn end (Task tool frames); checklistOpen is pending plus in-progress. Absent means
    // the turn kept no checklist at all.
    checklistTotal: z.number().optional(),
    checklistOpen: z.number().optional(),
    // compactions counts context compactions this turn. contextTokens/contextWindow are the last context_usage frame,
    // absent if unreported; raw numbers, not a percentage, since window size varies by model.
    compactions: z.number().optional(),
    contextTokens: z.number().optional(),
    contextWindow: z.number().optional(),
    // tierScore (0..1 from judgeComplexity, vs FAST_CEILING) absent means the judge did not run. tierRules is which
    // named features fired. tierRouted is whether it actually ran on the cheap rung, not implied by the score.
    tierScore: z.number().optional(),
    tierRules: z.array(z.string()).optional(),
    tierRouted: z.boolean().optional(),
    // The verdict and the cutoff it was judged against (settings.autoTierEagerness); absent rows predate the knob and
    // fall back to FAST_CEILING.
    tierFast: z.boolean().optional(),
    tierCeiling: z.number().optional(),
    // The turn carried AgentTurn.tierHold: the user vetoed a fast verdict. Absent means no veto.
    tierDenied: z.boolean().optional(),
});
export type UsageTurn = z.infer<typeof UsageTurnSchema>;
// Ledger grouped by day, provider, account, model, harness and conversation, one panel's worth of rows per active day.
// Conversation is part of the key so cost-by-agent can be windowed like every other panel.
export const UsageRollupRowSchema = z.object({
    day: z.string().describe("The day, as YYYY-MM-DD in UTC."),
    provider: z.string().describe("Which model provider."),
    account: z.string().optional().describe("Which account. Absent for work run on a plain key."),
    model: z.string().optional().describe("Which model."),
    harness: z.string().describe("Which agentic loop."),
    conversationId: z.string().optional().describe("Which conversation."),
    turns: z.number().describe("Turns in this group."),
    inputTokens: z.number().describe("Tokens sent."),
    outputTokens: z.number().describe("Tokens received."),
    cacheReadTokens: z.number().describe("Tokens served from cache."),
    cacheCreationTokens: z.number().describe("Tokens written to cache."),
    costUsd: z.number().describe("What the group cost, in dollars."),
    durationMs: z.number().describe("Time spent, in milliseconds."),
});
export type UsageRollupRow = z.infer<typeof UsageRollupRowSchema>;
// Inclusive UTC day bounds (YYYY-MM-DD); both absent means the whole ledger. Shared by every windowed ledger read, so
// filters stay in step.
export const DayWindowQuerySchema = z.object({
    from: z.string().optional().describe("First day to include, as YYYY-MM-DD in UTC. Leave it out for everything up to the end day."),
    to: z
        .string()
        .optional()
        .describe(
            "Last day to include, as YYYY-MM-DD in UTC, and it is included rather than excluded. Leave it out for everything from the start day onwards.",
        ),
});
export type DayWindowQuery = z.infer<typeof DayWindowQuerySchema>;
export const UsageRollupSchema = z.object({
    rows: z
        .array(UsageRollupRowSchema)
        .describe(
            "Spending grouped by day, provider, account, model and conversation. Everything a cost screen shows is a rearrangement of these rows, which is why there is no second call for any of it.",
        ),
});
// Account picker's headroom readout, folded from the ledger all-time (not a windowed log), grouped by provider and
// account. Env-token turns are excluded, not pooled under a blank id.
export const UsageAccountSchema = z.object({
    provider: z.string(),
    account: z.string(),
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    costUsd: z.number(),
});
export type UsageAccount = z.infer<typeof UsageAccountSchema>;
export const UsageSummarySchema = z.object({ accounts: z.array(UsageAccountSchema) });
