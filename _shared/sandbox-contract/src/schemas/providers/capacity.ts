import { z } from "zod";
import { AccountStateSchema, AccountUsageSchema } from "./plan-limits.js";
import { ModelCooldownSchema, ProviderRefusalSchema, SwitchOffsSchema } from "./refusals.js";

/* WHAT ONE PROVIDER'S ACCOUNTS CAN SERVE, AS THE DAEMON JUDGED IT, IN ONE MESSAGE. Before 2026-11-19 a window assembled
   the same picture from four reads that arrived apart (each provider's account rows, the translator's credentials, every
   reading pushed one account at a time, the refusals on file) and judged it with its own clock: two windows, or a window
   and the daemon, could hold different halves of it at once, and nothing said when the picture would change by the clock
   alone. This is the picture whole: every fact the serviceability rule (models/plan-pools.ts serviceStates) judged, each
   reading as it stood at `judgedAt`, the verdict it reached with no model named, where a turn naming no account would run,
   and the next instant the clock alone changes any of it (`validUntil`), at which the daemon judges again and sends the
   next one. A window asking about one model runs the same rule over these same facts, at the sandbox's clock. */

/** One account as the rule read it, and its verdict with no model named. */
export const CapacityAccountSchema = z.object({
    account: z.string().describe("The daemon's key for the account: a native account's id, a routed credential's auth-file name."),
    label: z.string().optional().describe("How the account is named to a person: its label, a routed credential's address."),
    needsReauth: z.boolean().optional().describe("Its sign-in was refused and has to be renewed on this sandbox."),
    detail: z.string().optional().describe("Why the sign-in needs renewing, in the provider's words, where it gave some."),
    seatRefusal: z.string().optional().describe("Its organisation took its seat away, in the provider's words."),
    cooling: z
        .object({ until: z.number().optional(), reason: z.string().optional(), verify: z.string().optional() })
        .optional()
        .describe("The translator's bench over the whole credential (TranslatorAccount.cooling)."),
    cooldowns: z.array(ModelCooldownSchema).optional().describe("The translator's benches of the credential on single models."),
    usage: AccountUsageSchema.optional().describe("Its plan-limit reading as it stood at `judgedAt`: a window past its reset already lapsed. Absent: unmeasured."),
    models: z.array(z.string()).optional().describe("The model ids its plan runs, where its source can say. Absent: unknown, never none."),
    state: AccountStateSchema.describe("The rule's verdict on it at `judgedAt`, with no model named."),
    flapping: z.literal(true).optional().describe("Its organisation switched it off twice or more this week: a pick ranks it behind every steady account of its tier."),
});
export type CapacityAccount = z.infer<typeof CapacityAccountSchema>;

/** A provider failing turns for reasons no account's allowance explains: down, or throttling every request for a while. */
export const ProviderDegradedSchema = z.object({
    cause: z
        .enum(["outage", "throttle"])
        .describe("`outage`: the provider is failing requests (5xx, overloaded, unreachable). `throttle`: it is turning requests away for a moment with a rate limit no allowance explains."),
    retryAt: z.number().describe("When the sandbox tries the provider again, in epoch milliseconds."),
    attempt: z.number().int().optional().describe("How many retries have gone out since it started failing."),
});
export type ProviderDegraded = z.infer<typeof ProviderDegradedSchema>;

export const ProviderCapacitySchema = z.object({
    provider: z.string().describe("Whose accounts these are."),
    seq: z
        .number()
        .int()
        .describe("Rises with every capacity the daemon sends, across providers, since it started: a window keeps the higher of two it holds for one provider."),
    judgedAt: z.number().describe("The sandbox's clock when these were judged, in epoch milliseconds."),
    validUntil: z
        .number()
        .optional()
        .describe(
            "The next instant the clock alone changes anything here (a window resetting, a refusal's instant, a bench ending, a switch-off ageing out), in epoch milliseconds; the daemon sends the next capacity then. Absent: nothing here changes with time.",
        ),
    accounts: z.array(CapacityAccountSchema).describe("Every connected account, in the provider's own order."),
    refusals: z.array(ProviderRefusalSchema).describe("Every refusal on file for the provider, as the ledger serves it."),
    switchOffs: SwitchOffsSchema.optional().describe("Each account's entitlement switch-offs within the week, the facts `flapping` is judged from."),
    placement: z.string().optional().describe("The account a turn naming no account and no model would run on now, where the provider has a choice to make."),
    degraded: ProviderDegradedSchema.optional().describe("Present while the provider itself is failing or throttling turns."),
});
export type ProviderCapacity = z.infer<typeof ProviderCapacitySchema>;

export const CapacitySnapshotSchema = z.object({
    providers: z.array(ProviderCapacitySchema).describe("Every provider with an account connected, or anything on file."),
});
export type CapacitySnapshot = z.infer<typeof CapacitySnapshotSchema>;

/** Where a turn on one model would run, asked of the daemon's one placement (usage.placement). */
export const PlacementQuerySchema = z.object({
    provider: z.string().min(1).describe("Which provider."),
    model: z.string().optional().describe("The model the turn names; absent for a turn naming none."),
    loop: z
        .string()
        .min(1)
        .optional()
        .describe(
            "The loop the turn runs on (an AgentHarness: `native` or a loop the provider offers), which decides which of its accounts can carry it. Absent, or one the daemon does not know: the provider's default loop.",
        ),
});
export const PlacementSchema = z.object({
    account: z.string().optional().describe("The account the daemon would run that turn on now. Absent: the provider has no account to choose, or chooses itself."),
    judgedAt: z.number().describe("The sandbox's clock when it was asked, in epoch milliseconds."),
    narrowed: z
        .literal(true)
        .optional()
        .describe(
            "The answer is the turn the asker would send: placed on the loop asked about, among the accounts the asker may run on (Access ▸ People). Absent from a daemon from before `loop`, whose answer is the sandbox-wide pick on the default loop.",
        ),
});
export type Placement = z.infer<typeof PlacementSchema>;
