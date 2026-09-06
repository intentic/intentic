// usage: the durable spend ledger
// usage: per-account token/cost totals
import { z } from "zod";
// One row per attributed turn, appended at turn end and NEVER pruned. This exists because the activity log
// can't answer a money question: it prunes to its most recent entries, so a month's spend is unanswerable and
//, worse for a cost readout, the totals SHRINK as newer turns evict older ones. The ledger keeps the raw
// per-turn facts and the rollup projects them on read, so a new grouping (by day, by model, by conversation)
// needs no new storage and no migration.
export const UsageTurnSchema = z.object({
    // Epoch ms at turn end. Kept alongside `day` so a future timezone-aware rollup is a pure change over data
    // already on disk.
    at: z.number().describe("When the turn ended, in milliseconds."),
    // The UTC calendar day (YYYY-MM-DD) `at` fell in, precomputed so a rollup never re-derives a timezone.
    day: z.string().describe("The day it fell in, as YYYY-MM-DD in UTC, worked out once so nothing downstream has to do timezone arithmetic."),
    provider: z.string().describe("Which model provider served it."),
    // Absent on an env-token turn, which has no account to attribute to (same rule as the activity log).
    account: z.string().optional().describe("Which account paid. Absent for a turn run on a plain key, which belongs to no account."),
    // The model the turn ACTUALLY ran, resolved past the client's pick and every provider default. Absent only
    // when the provider's own subscription default served it without the daemon naming one.
    model: z
        .string()
        .optional()
        .describe(
            "The model that actually ran, past whatever was asked for and every default. Absent only when the provider's own default served it without being named.",
        ),
    /* WHAT THE CLIENT ASKED FOR, beside `model` above, which is what ran. The pair is the point: a routing
     * surprise is then a diff on one row rather than an investigation through the routing code.
     *
     * The gap between the two is real and was unreadable. A pick is resolved past the tier judge's downgrade,
     * a provider's own subscription default, a catalog validity check that silently substitutes (Grok rejects
     * a retired models.dev id, so an invalid pin becomes the catalog default), and CLIProxyAPI's own choice on
     * a routed turn. Every one of those is a legitimate substitution and none of them was recorded, so "I
     * chose one model and got another's error" could only be answered by reading four resolution paths and
     * guessing which had fired.
     *
     * Absent ⇒ the client named nothing and asked for the default, which is not the same as asking for what it
     * got. Equal to `model` on the overwhelming majority of turns; the rows where they differ are the whole
     * reason this is here. */
    modelRequested: z
        .string()
        .optional()
        .describe("The model that was asked for, when one was named. Differs from `model` when something resolved it."),
    harness: z.string().describe("Which agentic loop it ran on."),
    /* HOW THE TURN ENDED. The field that turns the ledger from an accounting record into a diagnostic one.
     *
     * Without it a turn that died is byte-for-byte indistinguishable from one that succeeded, except that it
     * cost less, so "four sessions all broke a minute ago" had no record to read and had to be answered by
     * re-running the destructive act in a live sandbox. The failure was never nowhere: it was in the activity
     * log, which prunes to its most recent entries, so an incident survives only until the feed rolls past it.
     * This log is never pruned, which is the entire difference.
     *
     * "cancelled" is a user pressing Stop, which is not a failure and must never be read as one, the registry
     * learned that lesson already (see the abort branch in streamAgent). "error" is a turn the provider or the
     * request killed. Both still carry whatever they spent before they ended.
     *
     * Absent ⇒ the row predates this being recorded, NOT a turn that succeeded. Readers that count failures
     * must treat absent as unknown, and the experiment readers do exactly that. */
    outcome: z.enum(["ok", "error", "cancelled"]).optional().describe("How it ended: finished, failed, or was stopped by the user."),
    // The failing frame's code, when it carried one, e.g. `rate_limit`, `provider-outage`, `claude-not-entitled`.
    // Present only alongside outcome "error", and absent even then for a failure that named no code, which is
    // itself the interesting case: an unclassified failure is one nothing downstream knows how to handle.
    errorCode: z.string().optional().describe("The failure's code, when it had one."),
    // The failing frame's own sentence, capped at ERROR_MESSAGE_CHARS. Capped rather than omitted because the
    // provider's wording is routinely the only thing that distinguishes two failures sharing one code, and
    // uncapped it would let one bad provider message dominate a file that must stay cheap to read whole.
    errorMessage: z.string().optional().describe("What the failure said, trimmed."),
    // The conversation this turn belonged to, so spend can join to a fleet agent. Absent only for an internal
    // one-shot turn that has no conversation identity.
    conversationId: z
        .string()
        .optional()
        .describe(
            "Which conversation it belonged to, so spending can be traced to a card. Absent only for an internal one-off with no conversation at all.",
        ),
    // The provider's own turn count for the request (a Claude "turn" can be several under the hood), so turns
    // and cost stay comparable across providers. 1 when the provider reported none.
    turns: z
        .number()
        .describe("The provider's own count for the request, since one exchange can be several under the hood. One when it reported none."),
    inputTokens: z.number().describe("Tokens sent."),
    outputTokens: z.number().describe("Tokens received."),
    cacheReadTokens: z.number().describe("Tokens served from cache, which cost less."),
    cacheCreationTokens: z.number().describe("Tokens written to cache, which cost more up front and less afterwards."),
    costUsd: z.number().describe("What it cost, in dollars."),
    durationMs: z.number().describe("How long it took, in milliseconds."),
    /* Which arm of the iq SEARCH-TEACHING experiment this conversation runs on
     * (settings.iqSearchHoldout). Stable for every turn in one conversation: the treatment is instruction
     * loaded into a provider session, so flipping it per turn would call a remembered treatment a control.
     * Absent ⇒ measurement is off; true/false ⇒ taught/cold. */
    iqSearchArm: z.boolean().optional(),
    // Hash of the plugin nudge + skill body used for this arm. Control turns carry it too, so a report can keep
    // both sides of one treatment revision together and exclude older wording after an upgrade.
    iqSearchCohort: z.string().optional(),
    /* SEARCHES THIS TURN RAN, every tool call that went looking for code, the dedicated search tools and the
     * CLI searches alike (isSearchCall owns the rule; `iq q` is Bash and would otherwise not be counted at all).
     * What the search teaching is judged on.
     *
     * COST PER TURN CANNOT SERVE: cost is a whole turn's worth of work, a search mechanism touches one part of
     * it, and the part lives inside the noise of the rest, exactly the shape that made output tokens unable to
     * see the steer. Nine days of a since-removed retrieval experiment proved it with an interval from −2.9% to
     * +56.9%, driven entirely by which arm had drawn the bigger jobs.
     *
     * Searches are what the mechanism acts on directly. Turns that never search stay in the population at zero
     * rather than being filtered out, they dilute both arms equally, while selecting on "did it search" would
     * select on the treatment itself.
     *
     * Absent ⇒ the turn predates this being measured; the arm's mean drops it (turn-experiments.ts, the filter
     * inside `conversationExperimentOf`) rather than reading it as a turn that searched nothing. */
    searchCalls: z.number().optional(),
    /* …and how many of them came BEFORE the turn first opened or changed a file, the orientation burst. A turn
     * that already knows where to look starts working; one that doesn't goes hunting first.
     *
     * The narrower of the two readings and the less confounded: `searchCalls` still grows with the size of the
     * job, while the walk up to the first file is roughly the same act whatever the job turns out to be.
     *
     * A turn that never reads or edits counts all of its searches here, it never arrived, so all of it was
     * orientation. Dropping those instead would select the population by an OUTCOME the treatment moves, which
     * is the one bias an arm-based reading cannot absorb.
     *
     * Absent ⇒ as for `searchCalls`. */
    openingSearches: z.number().optional(),
    /* THE LISTINGS THIS TURN RAN TO WORK OUT WHERE IT WAS, `ls`, `ls /work`, `tree intentic`, the LS tool
     * aimed at the same places (isRootListing owns the rule). What the project map is judged on, and the
     * reason it could not be judged before.
     *
     * `searchCalls` counts a directory listing and a ripgrep as one event, deliberately, so that a taxonomy
     * cannot report whichever spelling of a search the model happened to reach for. That is right for the
     * search teaching and blind to the map: measured over 468 mapped sessions of this workspace against 497
     * unmapped ones, searches before the first file moved +7.6% with a margin of ±17.6pp, while the share of
     * sessions opening with a directory listing fell from 46.3% to 32.1%. The map does not shorten the
     * orientation burst, it changes what the burst is made of, and only this counts the difference.
     *
     * UP TO THE FIRST FILE, exactly like `openingSearches`, which took the corpus to settle. Counted over the
     * whole turn instead, the same sessions give 66.4% against 73.3%, a gap of 6.9pp where the orientation
     * window gives 14.2pp. The dilution is not noise: a turn already at work lists the directory it has
     * narrowed to, and no map could have answered that. The shape of the listing cannot tell the two apart,
     * because it is the same shape; only when it happened can.
     *
     * Absent ⇒ the turn predates this being measured, never a turn that listed nothing. */
    openingListings: z.number().optional(),
    /* TOOL CALLS BEFORE THE TURN FIRST TOUCHED A FILE IT WENT ON TO EDIT: how far it walked before reaching
     * the thing it turned out to be looking for. The corpus study this map was designed from measured the
     * same quantity by hand (the workspace's docs/agent-exploration-patterns.md §4: median 4, mean 8.2) and called it the one
     * honest reading of whether orientation got better.
     *
     * IT CAN ONLY BE KNOWN AT THE END, which is why it is recorded here and computed nowhere else: whether a
     * file was the target is a fact about the turn's edits, and the turn has to finish before that is
     * decided. The route keeps the first call index per path and intersects it with the edit ledger.
     *
     * Absent on a turn that edited nothing, which is most short turns, and NOT zero: a turn with no target
     * never reached one, and averaging that in as "reached it immediately" would report the turns that did
     * no work as the best targeted. That absence costs the reading three quarters of the population, so it
     * is a metric to accumulate for months rather than a gate to wait on. */
    callsBeforeTarget: z.number().optional(),
    /* WHICH ARM OF THE PROJECT MAP EXPERIMENT this conversation ran (settings.workspaceMapHoldout), and how
     * many characters the note actually cost when it was sent.
     *
     * CONVERSATION-STABLE, and for a plainer reason than the search teaching's: the map is sent once, on the
     * opening message, so every later turn of a mapped conversation is a turn whose transcript holds a map.
     * A per-turn flip would label eleven treated turns as controls.
     *
     * `mapChars` rather than a token estimate, because characters are what the renderer's budget is in
     * (workspace-map.ts caps the note at 2,800) and a tokenizer's answer would vary by model. Present only on
     * the turn that actually sent one, so the ledger says what the feature costs instead of assuming it: the
     * median note over this workspace's own corpus is 795 characters against a ceiling of 2,800.
     *
     * Absent ⇒ no measurement (the holdout is zero, or the row predates it); true/false ⇒ mapped/unmapped. */
    mapArm: z.boolean().optional(),
    mapChars: z.number().optional(),
    /* WHICH TURN OF ITS CONVERSATION THIS WAS, counting from zero, so an opening turn can be recognised from
     * one row instead of inferred from the rows around it.
     *
     * The inference it replaces is wrong at exactly one place and it is the place that matters: a reader
     * windowed to the last seven days would take each conversation's earliest row IN THE WINDOW as its
     * opening turn, so every conversation that started the week before would contribute a mid-conversation
     * turn to a reading about first turns. The project map is sent on turn zero and nowhere else, so that
     * misreading is not an edge case for it, it is the measurement.
     *
     * Absent ⇒ the row predates this, or the turn belonged to no conversation at all. */
    turnIndex: z.number().optional(),
    /* DID THIS TURN FINISH, OR DID IT STOP TALKING. The fields that tell the two apart, and the reason
     * `outcome` alone could never.
     *
     * A turn ends at least five different ways: its stop condition was met, the model ran out of things to say,
     * the loop hit a cap, the budget ran out, or the model asserted it was done and nothing checked the claim.
     * `outcome` collapses four of those into "ok", so a ledger that already recorded every failure perfectly
     * still wrote the same word over a turn that proved its work and a turn that went quiet halfway through its
     * own checklist. The daemon was computing the difference and discarding it at turn end.
     *
     * NO SINGLE STOP-REASON WORD IS STORED, deliberately: these are the facts, and which of the five modes they
     * add up to is a rule that will get better. A word written down now would freeze today's rule into rows
     * that outlive it and cannot be re-read under the next one, the same reason `tierRouted` is recorded beside
     * `tierScore` instead of being derived from it once and forgotten.
     *
     * `verification` is the four-state VerificationState the child roster already speaks (agent-verification.ts):
     * "verified" = a check passed AFTER the last code edit, "failing" = the last one after it did not,
     * "unproven" = nothing ran, "no-code" = nothing a check could speak to was edited. Folded from this turn's
     * own tool-call frames, subagents' included, so a Codex turn is judged exactly as a Claude one is. Absent ⇒
     * the row predates this, NOT a turn nothing was known about.
     *
     * `check` is the command that SPOKE, the one that cleared the work or the one that broke, capped. It is
     * what keeps "verified" auditable: a passing `vitest run one.test.ts` is evidence about one file and must
     * never read as the repo being green, and only the command itself shows which was which.
     *
     * `filesEdited` counts every file written, prose included, where `verification` speaks only about code. The
     * pair is the point: `{ verification: "no-code", filesEdited: 3 }` is a documentation turn, and
     * `{ verification: "unproven", filesEdited: 0 }` cannot happen. */
    verification: z.enum(["verified", "unproven", "failing", "no-code"]).optional(),
    check: z.string().optional(),
    filesEdited: z.number().optional(),
    /* THE AGENT'S OWN CHECKLIST WHEN THE TURN ENDED, reconstructed from the Task tool family and reported by
     * every runtime that keeps one (`todos` frames). `checklistOpen` is pending plus in-progress.
     *
     * This is the honest reading of "the model stopped emitting": a turn that ended `ok` with items still open
     * abandoned a plan it wrote itself, which is a different event from a turn that finished one, and the two
     * were indistinguishable in every record this daemon kept. Absent ⇒ the turn kept no checklist at all,
     * which is most short turns and is not the same as an empty one. */
    checklistTotal: z.number().optional(),
    checklistOpen: z.number().optional(),
    /* HOW MANY TIMES THE CONTEXT WAS COMPACTED under this turn, and how full the window was when it ended.
     *
     * Compaction is the least observable thing a harness does to a turn: a poorly timed one discards the
     * partial result the turn still needed, and the only trace was a frame streamed to whoever was watching.
     * Recorded here, "did compaction hurt" becomes a question this ledger can answer, by joining these against
     * `verification` and `outcome` over months of real turns, which is a number nobody currently has.
     *
     * `contextTokens`/`contextWindow` are the last `context_usage` frame, absent for a runtime that reports
     * none. Both, rather than a percentage: the window is a per-model constant that moves between model
     * versions, and a fraction computed today cannot be recomputed tomorrow from what it threw away.
     *
     * Together they carry ~90 bytes onto a ~250-byte row. A heavy day is ~100 turns, so a year of hard use goes
     * from ~9 MB to ~12 MB, which is the price of a log that can answer why a turn ended rather than only what
     * it cost. */
    compactions: z.number().optional(),
    contextTokens: z.number().optional(),
    contextWindow: z.number().optional(),
    /* WHAT THE COMPLEXITY JUDGE SAID ABOUT THIS TURN, and whether anything was done about it. The three fields
     * automatic tier selection is calibrated from, and the reason it can ship in shadow at all.
     *
     * They live on the SPEND ledger rather than in a log of their own because the question they exist to answer
     * is a question about money: what did the turns we would have downgraded actually cost, and what did the
     * ones we did downgrade cost instead. A separate log would have to be joined back to this one on every
     * read, and the join key (a turn) is already the row.
     *
     * `tierScore` is 0..1 from judgeComplexity, comparable against FAST_CEILING, which is the cutoff it was
     * judged against at the time. Absent ⇒ the judge did not run (settings.autoTier "off", or a row written
     * before this existed), which is NOT the same as a turn that scored zero.
     *
     * `tierRules` is which named features fired, and it is the half that makes the ledger analysable rather
     * than merely tallyable: a score says a threshold was crossed, the rules say which feature is doing the
     * work, and re-fitting the weights needs the second. Bounded by construction, there are ~19 of them.
     *
     * `tierRouted` is whether the turn ACTUALLY ran on the cheap rung. It is not implied by the score: a turn
     * judged fast still runs standard in shadow mode, and still runs standard in `on` mode when the provider
     * publishes nothing cheaper than the user's pick. Reading the score as the decision would report savings
     * that were never made. */
    tierScore: z.number().optional(),
    tierRules: z.array(z.string()).optional(),
    tierRouted: z.boolean().optional(),
    /* THE VERDICT ITSELF, and the cutoff it was reached against.
     *
     * `tierScore` stopped being able to answer "was this called simple" the moment the cutoff became the owner's
     * to choose (settings.autoTierEagerness): 0.35 is standard on the middle stop and fast on the eager one, and
     * a fast verdict also requires a positively-easy signal that no score can express. So the answer is written
     * down rather than re-derived, and the ceiling goes with it because a refit reading a column of bare scores
     * could not otherwise tell two rows apart.
     *
     * Absent on rows written before the knob existed, which were all judged at the `balanced` cutoff — which is
     * exactly what a reader falls back to (FAST_CEILING), so old and new rows stay one population. */
    tierFast: z.boolean().optional(),
    tierCeiling: z.number().optional(),
    /* THE USER SAID NO: the turn carried AgentTurn.tierHold, so a fast verdict moved nothing. Recorded rather
     * than folded into `tierRouted: false` because it is the strongest calibration label this ledger ever gets,
     * a person looking at this very conversation deciding the cheap rung was not to be trusted with it, and the
     * refit (docs/model-routing-design.md §4) needs it kept apart from "nothing cheaper was published". Absent ⇒
     * no veto, which is every row written before the control existed and most rows after. */
    tierDenied: z.boolean().optional(),
});
export type UsageTurn = z.infer<typeof UsageTurnSchema>;
// The ledger grouped by day × provider × account × model × harness × conversation, the finest grouping any
// dashboard panel needs, and a handful of rows per active day instead of one per turn, so a year of history is
// well under a MB over the tunnel. Every panel (spend per day, cost by model, cost by agent, cache hit rate) is
// a projection of these.
// The conversation is in the KEY, not merely along for the ride, because cost-by-agent has to answer within the
// same window as every other panel on the screen. The fleet registry also carries a per-agent total, but only a
// cumulative, all-time one, reading it beside a "last 7 days" filter would print an all-time number under a
// windowed heading, which is the shrinking-totals bug wearing a different hat.
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
// Inclusive UTC day bounds (YYYY-MM-DD). Both absent ⇒ the whole ledger. Shared by every windowed read of a
// daemon ledger (spend, savings): one window shape, so a screen that filters two ledgers at once filters them
// with the same calendar.
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
// The account picker's headroom readout, folded from the ledger above (all-time, not a log window), grouped by
// provider+account. `account` is the attribution key, so env-token turns are excluded rather than pooled under
// a blank id, an unattributed turn belongs to no account's total.
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
