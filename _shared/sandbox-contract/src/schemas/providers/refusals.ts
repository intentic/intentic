import { z } from "zod";

// WHAT A PROVIDER SAID WHEN IT REFUSED A TURN, and the ledger of them the sandbox answers with. Kept out of plan-limits.ts,
// which re-exports both, so the plan and turn schemas there stay within one file's reach.

// Observed and exact, unlike a polled usage snapshot that can be stale; filed by provider, naming the account it refused
// wherever that is known (a routed turn's since the daemon's gateway places each request on one: 2026-11-08), and judged
// on that account alone. `kind` is read off what the provider said, not the frame code.
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
    // Absent only where nothing names the account that refused: such a refusal is judged on each account by that
    // account's own reading (refusal-verdict.ts).
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
    // Stamped by the daemon's ledger as it files a spent allowance naming its instant (refusal-verdict.ts refusedPoolOf),
    // from the refused account's reading then: which pool that instant is the reset of. Before 2026-11-19 every judgement
    // worked it out again from whatever reading it held, by matching resets within half an hour, and a Codex refusal on
    // one model was pinned on the weekly pool that gates them all for four days (2026-11-14). Absent on a refusal filed
    // before, or where the reading could not say: the rule then still works it out as it judges.
    pool: z
        .string()
        .optional()
        .describe(
            "For a spent allowance that named when to try again: the `kind` of the refused account's pool (`UsageWindow.kind`) that instant is the reset of, resolved when it was filed. That pool reads full until then.",
        ),
    poolUnpublished: z
        .literal(true)
        .optional()
        .describe(
            "Set on a spent allowance whose instant was the reset of no pool the refused account's reading published when it was filed: a pool of its own, such as one model's cap, which holds only the model it refused.",
        ),
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
    // Heard from the platform rather than refused here (2026-11-24, docs/architecture/account-routing.md): another of the
    // owner's sandboxes signed in to the same provider account was refused for a spent allowance. Judged as a limit
    // refusal like any other, and settled the same way: a turn answered here proves the account has room again.
    source: z
        .enum(["another-sandbox"])
        .optional()
        .describe(
            "Where the refusal was seen, when not here: `another-sandbox` for a spent allowance another of the owner's sandboxes on the same account reported. Absent for one this sandbox's own turn met.",
        ),
});
export type ProviderRefusal = z.infer<typeof ProviderRefusalSchema>;
// A routed account's per-model bench as the translator holds it: the provider's own refusal of that account on that
// model, kept where the translator keeps it rather than copied onto the ledger, so it ends when the provider said.
export const ModelCooldownSchema = z.object({
    model: z.string().describe("The model the provider refused this account on, as the translator names it."),
    until: z.number().describe("When the provider said to try again, in epoch seconds."),
});
export type ModelCooldown = z.infer<typeof ModelCooldownSchema>;
// A released daemon (1.345.0 and earlier) answers one refusal per provider, its last: read as a list of one, as the
// /events frame's `refusal` is (refusalsOf). What this build sends, and its output shape, is still the list.
const RefusalsOnFileSchema = z.codec(z.union([z.array(ProviderRefusalSchema), ProviderRefusalSchema]), z.array(ProviderRefusalSchema), {
    decode: (filed) => (Array.isArray(filed) ? filed : [filed]),
    encode: (list) => list,
});
// Each account's entitlement switch-offs within the week (epoch ms, oldest first), keyed by account id: the facts the
// flapping rule reads (plan-pools.ts flappingAccounts), so every window places an unnamed turn as the daemon does.
export const SwitchOffsSchema = z.record(z.string(), z.array(z.number()).readonly());
export const ProviderRefusalsSchema = z.object({
    refusals: z
        .record(z.string(), RefusalsOnFileSchema)
        .describe(
            "Every refusal on file per provider, each the latest of its kind for the account and model it names: what every verdict on that provider's accounts is judged against. Read alongside an account's usage: that says how full it was when last checked, these say whether it has since started saying no.",
        ),
    switchOffs: z
        .record(z.string(), SwitchOffsSchema)
        .optional()
        .describe(
            "Per provider, each account's entitlement switch-offs within the last week (epoch ms, oldest first): an account switched off twice or more in that span keeps being switched off, and a turn naming no account is placed on a steady one before it. Absent from a daemon that predates it.",
        ),
});
export type ProviderRefusals = z.infer<typeof ProviderRefusalsSchema>;
