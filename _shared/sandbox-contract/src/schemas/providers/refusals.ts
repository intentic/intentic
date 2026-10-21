import { z } from "zod";

// WHAT A PROVIDER SAID WHEN IT REFUSED A TURN, and the ledger of them the sandbox answers with. Kept out of plan-limits.ts,
// which re-exports both, so the plan and turn schemas there stay within one file's reach.

// Observed and exact, unlike a polled usage snapshot that can be stale; keyed by provider, not account, since a routed
// turn doesn't know which served it. `kind` is read off what the provider said, not the frame code.
export const ProviderRefusalSchema = z.object({
    // Read side by side with `AccountUsage.measuredAt` (also ms).
    at: z.number().describe("When it refused, in milliseconds."),
    // Only a turn that actually runs settles an entitlement refusal — nothing else can.
    kind: z
        .enum(["limit", "auth", "entitlement"])
        .describe(
            "Three different noes, kept apart because what fixes each is different. A spent allowance is answered by waiting; a refused credential by signing in again; and an entitlement refusal, where somebody has switched this off for your seat, by neither of those. That last one authenticates fine and reports healthy limits the whole time it refuses everything.",
        ),
    message: z.string().describe("The provider's own words, verbatim. The only part that says which limit or which credential."),
    // Known for native turns only; a routed turn doesn't say which account served it.
    account: z.string().optional().describe("Which account was serving, where that is known."),
    // Lets a `limit` refusal be read against the pool that model spends (`UsageWindow.gates`), not the account's
    // fullest pool.
    model: z.string().optional().describe("Which model the refused turn was on, where that is known."),
    // The provider's own "try again at …", which a polled reading cannot contradict: a usage endpoint can keep showing
    // room while the plan refuses every turn.
    resetsAt: z
        .number()
        .optional()
        .describe(
            "When the provider said to try again, in epoch seconds, for a spent allowance where it named one. Until then the refusal stands whatever a reading says; after it, it is over.",
        ),
    // Stamped by the daemon's ledger as it files a spent allowance naming no instant (plan-pools.ts refusedPoolReset).
    poolResetsAt: z.number().optional().describe("Epoch seconds the refused pool reopens, for a spent allowance naming no time: it ends then."),
    // Cursor's "ask your admin to increase your limit": a team's spend limit, which no usage endpoint reads. Not Codex's
    // "send a request to your admin", which names a window its reading measures (failure-sentences.ts ADMIN_GRANTED).
    unmetered: z
        .literal(true)
        .optional()
        .describe(
            "Set on a spent allowance no usage reading measures, such as a credit an organisation's admin grants. No reading answers it: it stands until the provider's own reset, or until a turn is answered.",
        ),
    byHand: z
        .literal(true)
        .optional()
        .describe(
            "Set by a person rather than by a refused turn, for a plan nothing can read: believed for a day, or until unmarked or a turn on it is answered.",
        ),
});
export type ProviderRefusal = z.infer<typeof ProviderRefusalSchema>;
// A released daemon (1.345.0 and earlier) answers one refusal per provider, its last: read as a list of one, as the
// /events frame's `refusal` is (refusalsOf). What this build sends, and its output shape, is still the list.
const RefusalsOnFileSchema = z.codec(z.union([z.array(ProviderRefusalSchema), ProviderRefusalSchema]), z.array(ProviderRefusalSchema), {
    decode: (filed) => (Array.isArray(filed) ? filed : [filed]),
    encode: (list) => list,
});
export const ProviderRefusalsSchema = z.object({
    refusals: z
        .record(z.string(), RefusalsOnFileSchema)
        .describe(
            "Every refusal on file per provider, each the latest of its kind for the account and model it names: what every verdict on that provider's accounts is judged against. Read alongside an account's usage: that says how full it was when last checked, these say whether it has since started saying no.",
        ),
});
export type ProviderRefusals = z.infer<typeof ProviderRefusalsSchema>;
