// settings-savings: what each token-reduction mechanism saved and how the turn-level ones are measured, as the
// settings routes report them. Re-exported by settings.ts, whose routes carry them.
import { z } from "zod";

// What each token-reduction mechanism actually saved. Input-side: both sides of the comparison come off the same
// command (raw in, emitted out), so the counterfactual is observed, not estimated — exact, per command.

// Sequential attribution (sums exactly to raw − emitted, drawable as a stacked bar); not what disabling this stage
// would save, since downstream would eat some of the same lines. Negative for `footer`, which adds cost back.
export const SavingsStageSchema = z.object({ id: z.string(), commands: z.number(), savedTokens: z.number() });
// Aggregated from historyRoot/logs/filter-stats.jsonl (one row per Bash command). Windowed on the ledger's own UTC-day
// calendar, so the reader's date range and these figures agree.
export const InputSavingsSchema = z.object({
    // Epoch ms of the ledger's last command, so the card can show its age rather than implying freshness.
    updatedAt: z.number().optional(),
    commands: z.number(),
    rawTokens: z.number(),
    emittedTokens: z.number(),
    savedPct: z.number(),
    // Per-stage attribution, biggest first.
    perCleaner: z.array(SavingsStageSchema),
    // The measured control (raw vs. cleaned); the only real whole-pipeline counterfactual, not an estimate.
    holdout: z.object({ cleaned: z.number(), heldOut: z.number(), measuredSavedPct: z.number().optional() }),
    // Grouped by command text: worth a handler is judged by total tokens across runs, not one outlier's size.
    gaps: z.array(z.object({ command: z.string(), commands: z.number(), tokens: z.number() })),
});
export type InputSavings = z.infer<typeof InputSavingsSchema>;
// One arm of a turn-level experiment; mean is per turn, since the two arms never hold the same count.
// `mean` is over samples capped at both arms' pooled 95th percentile, so one runaway conversation cannot carry an arm.
// For a yes/no reading (`openedWithListing`) it is the share of yeses, 0 to 1, and uncapped.
export const SavingsArmSchema = z.object({ turns: z.number(), mean: z.number() });
// One metric's reading of a turn-level experiment (the two arms, plus the arithmetic over them). `metric` says what
// `mean`/`deltaPct` count:
// searchCalls: searches a turn ran (the search teaching).
// openingSearches: same, narrowed to before the turn first touched a file.
// openedWithListing: whether a turn listed directories to orient itself, as a share of turns (the project map).
// callsBeforeTarget: how far a turn walked before touching a file it went on to edit.
// failedCalls: tool calls that ended in error (the field notes, whose largest section is a failure taxonomy).
// openingPrompt: tokens a turn's first request sent (cache reads plus cache writes), which is what every later call of
// the turn reads again (tool search, which moves the tool schemas out of it).
// openingWrite: tokens a follow-up turn's first request wrote to the cache instead of reading them (the stable prompt).
// Every reading is the main agent's own: a subagent's calls are counted toward the turn and read for nothing.
// Never cost: each mechanism moves one small part of a turn's work, inside the noise of the rest. The prompt's size is
// the exception that proves it: it is the part every call pays again, so it is read directly rather than through cost.
export const TurnMetricReadingSchema = z.object({
    metric: z.enum(["searchCalls", "openingSearches", "openedWithListing", "callsBeforeTarget", "failedCalls", "openingPrompt", "openingWrite"]),
    on: SavingsArmSchema,
    off: SavingsArmSchema,
    // Additional control turns to reach a fixed target resolution, not today's delta (which inherits noise and always
    // promises "next week"). Absent means nothing to wait for: under `minTurns`, already published, or already resolved
    // enough.
    controlTurnsNeeded: z.number().optional(),
    // ± percentage points at 95% (Welch); present once both arms clear `minTurns`, even when `deltaPct` is withheld —
    // "smaller than ±35 points" is still a useful, true answer.
    marginPct: z.number().optional(),
    // Present only once the margin excludes zero — clearing `minTurns` alone isn't enough, or a wide, unresolved swing
    // reads as a real number.
    // deltaPct: change in the metric's mean per turn; negative is a saving.
    // saved: what that delta was worth over the turns that ran with it, in the metric's own unit.
    deltaPct: z.number().optional(),
    saved: z.number().optional(),
});
export type TurnMetricReading = z.infer<typeof TurnMetricReadingSchema>;
// One coin flip, several readings: `metrics` is a list since splitting readings into separate entries would duplicate
// the arm assignment. Screens read `metrics[0]` as the headline, the rest as supporting lines.
export const TurnExperimentSchema = z.object({
    // A head and a tail, not a plain array, so "always a headline" is a type fact, not a check every screen repeats.
    // `.nonempty()` doesn't do this in zod 4 (a runtime check, still typed as a plain array).
    metrics: z.tuple([TurnMetricReadingSchema], TurnMetricReadingSchema),
    // Carried on the wire so "measuring…" reflects the daemon's real threshold, not a guess; shared across every
    // reading, since they're the same turns.
    minTurns: z.number(),
    // Turn mechanisms randomize by turn; session-loaded teaching randomizes whole conversations; a once-sent treatment
    // (the map) samples one turn per conversation, not an average, or its effect divides by the conversation's length.
    sampleUnit: z.enum(["turns", "conversations", "opening turns"]).optional(),
    // Content-addressed treatment version; the reader filters to the latest so two instruction revisions don't blur
    // into one experiment.
    cohort: z.string().optional(),
    // The latest earlier cohort that reached an answer, with only its answered readings (a margin, with or without a
    // delta), so restarting a comparison does not wipe a finding off the screen while the new one is early. `from` and
    // `to` are its first and last measured turn inside the window read, epoch ms. Absent when no earlier one answered.
    previous: z
        .object({ from: z.number(), to: z.number(), cohort: z.string().optional(), metrics: z.array(TurnMetricReadingSchema) })
        .optional(),
    // Whether the treatment was taken up at all, which no reading above can tell: the share, 0 to 1, of each group's
    // searches that ran iq, pooled over the turns of this cohort that recorded it. `turns` is the treated group's count;
    // absent until it reaches `minTurns`. The search teaching only.
    uptake: z.object({ on: z.number(), off: z.number(), turns: z.number() }).optional(),
});
export type TurnExperiment = z.infer<typeof TurnExperimentSchema>;
// What the settings row can say about the brief without opening it: whether there is one, how much of it this budget
// reaches, and whether anything is scheduled to rewrite it. Read off the file and the automation store, never stored.
export const FieldNotesStatusSchema = z.object({
    // False means the automation has never run (or was never set up) — the ordinary state before the first month.
    present: z.boolean(),
    // Epoch ms the file was last written. Absent when there is no file.
    writtenAt: z.number().optional(),
    // How many ranked sections the current budget reaches, out of how many the file holds. The pair is the point: "5"
    // alone cannot tell a generous budget from a short file.
    ranksSent: z.number().optional(),
    ranksTotal: z.number().optional(),
    // What the brief costs the prompt, in characters, at the current budget.
    chars: z.number().optional(),
    // The monthly rewrite: absent until the owner creates it from the offered template, since an automation names the
    // models it spends and nothing chooses those for them.
    automation: z.enum(["missing", "enabled", "disabled"]),
    // When it next runs, epoch ms; absent when there is nothing scheduled.
    nextRunAt: z.number().optional(),
    // Said out loud rather than shown as "no file": a brief that exists and cannot be read is a broken automation.
    unreadable: z.string().optional(),
    // Blocks of the file its priority table does not rank, so no limit ever sends them. Absent when there are none.
    unlisted: z.array(z.string()).optional(),
});
export type FieldNotesStatus = z.infer<typeof FieldNotesStatusSchema>;
export const SavingsReportSchema = z.object({
    input: InputSavingsSchema,
    search: TurnExperimentSchema.optional(),
    // Same absence rule as `search`: not measured, never zero.
    map: TurnExperimentSchema.optional(),
    notes: TurnExperimentSchema.optional(),
    toolSearch: TurnExperimentSchema.optional(),
    stablePrompt: TurnExperimentSchema.optional(),
    coldTrim: TurnExperimentSchema.optional(),
});
export type SavingsReport = z.infer<typeof SavingsReportSchema>;
