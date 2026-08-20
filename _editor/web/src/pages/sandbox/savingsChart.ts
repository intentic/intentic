import type { FigureAccent } from "@intentic/ui/markdown";
import { seriesColor } from "@intentic/ui/series";
import type { InputSavings, TurnExperiment, TurnMetricReading } from "@intentic/sandbox-contract";
import { formatCompact } from "./usageChart";

/* Every number and every mark on the Savings surfaces, as pure functions over the daemon's savings report,
 * the same split as usageChart.ts, and for the same reason: the arithmetic under a "89% saved" claim should be
 * testable without mounting a component.
 *
 * The two families the report carries are never merged into one ranking here. The cleaners' savings are exact
 * (each command yields its own raw baseline); the terse steer's are an experiment with a sample size. A single
 * chart of both would lend the second the first's confidence. */

// --- mechanism identity -------------------------------------------------------------------------------------

// Every toggleable cleaner id + a short label, in the order of bin/cleaners.mjs CLEANERS (keep in sync). The
// Agent tab renders one switch per entry and the savings surfaces label their marks from the same list, so a
// mechanism cannot end up named two different things on two screens.
export const CLEANER_OPTIONS = [
    { id: `pnpm`, label: `pnpm` },
    { id: `apt`, label: `apt` },
    { id: `test`, label: `test runners` },
    { id: `ls`, label: `directory listings` },
    { id: `files`, label: `file lists` },
    { id: `dedup`, label: `dedupe repeats` },
    { id: `cap`, label: `head/tail cap` },
    { id: `redact`, label: `redact secrets` },
    { id: `cache`, label: `collapse repeats` },
] as const;

export const ALL_CLEANER_IDS: readonly string[] = CLEANER_OPTIONS.map((cleaner) => cleaner.id);

// Stages the ledger attributes savings to that have NO switch on the settings page, they are unconditional
// parts of the filter. Named rather than folded into "other": a reader comparing the chart to the checklist
// above it must be able to tell "this mechanism isn't listed" from "this mechanism isn't yours to turn off".
const FIXED_STAGE_LABELS: Record<string, string> = {
    ansi: `terminal escapes`,
    failtail: `failure tail cap`,
    footer: `retrieval footer`,
    guard: `refused (output grew)`,
};

export const stageLabel = (id: string): string => CLEANER_OPTIONS.find((cleaner) => cleaner.id === id)?.label ?? FIXED_STAGE_LABELS[id] ?? id;

// --- the composition bar ------------------------------------------------------------------------------------

// How many mechanisms get their own slot before the tail is folded. Five is the validated categorical palette's
// width (usageChart.ts PROVIDER_SERIES), a sixth hue would be one this design system has never checked for
// adjacent-pair contrast.
const SLOTS = 5;

// The palette's slots, named directly. This used to be a list of PROVIDER names, claude, codex, kimi…, fed
// through the provider→slot lookup purely to arrive back at slots 1–5, because slot→colour was not reachable
// on its own. It is now (`seriesColor` is exported), so the detour is gone: nothing here is about providers.
const SLOTS_BY_RANK = [`1`, `2`, `3`, `4`, `5`] as const satisfies readonly FigureAccent[];

export interface SavingsSegment {
    readonly key: string;
    readonly label: string;
    readonly tokens: number;
    readonly color: string;
    // "reached" is what the model was actually handed, not a mechanism, and coloured so it can never be read
    // as one. It is the segment the whole chart exists to make visible.
    readonly kind: "saved" | "reached";
}

export interface Composition {
    // Segments summing exactly to `rawTokens`, in draw order: the mechanisms that removed the most, the folded
    // tail, then what reached the assistant.
    readonly segments: readonly SavingsSegment[];
    readonly rawTokens: number;
    // Tokens the filter ADDS back as retrieval pointers. Not a segment: it is already inside the emitted total,
    // so stacking it would make the bar sum to more than the raw output it is a decomposition of. Disclosed as
    // its own line instead, it is the price of the trimming being reversible, and hiding a cost inside a
    // savings chart is how these screens start lying.
    readonly footerTokens: number;
}

export const compositionOf = (input: InputSavings): Composition => {
    const saved = input.perCleaner.filter((stage) => stage.savedTokens > 0).toSorted((left, right) => right.savedTokens - left.savedTokens);
    const footer = input.perCleaner.find((stage) => stage.id === `footer`);
    const head = saved.slice(0, SLOTS);
    const tail = saved.slice(SLOTS);

    const segments: SavingsSegment[] = head.map((stage, index) => ({
        key: stage.id,
        label: stageLabel(stage.id),
        tokens: stage.savedTokens,
        // Slot by RANK, unlike the provider charts where colour follows the entity for good. There are more
        // possible mechanisms than the five checked slots, so an entity-stable mapping isn't available; the
        // ranked list beside the bar carries identity, and every segment names itself on hover.
        color: seriesColor(SLOTS_BY_RANK[index] ?? `neutral`),
        kind: `saved`,
    }));
    if (tail.length > 0) {
        segments.push({
            key: `other`,
            label: `${tail.length} more`,
            tokens: tail.reduce((sum, stage) => sum + stage.savedTokens, 0),
            color: `var(--color-series-other)`,
            kind: `saved`,
        });
    }
    // What reached the model, as the remainder, which is exactly the emitted total minus the footers the
    // filter added back, and keeps the bar summing to the raw output rather than to a number of its own.
    const removed = segments.reduce((sum, segment) => sum + segment.tokens, 0);
    segments.push({
        key: `reached`,
        label: `reached the assistant`,
        tokens: Math.max(0, input.rawTokens - removed),
        color: `var(--color-content-subtle)`,
        kind: `reached`,
    });

    return { segments, rawTokens: input.rawTokens, footerTokens: footer === undefined ? 0 : Math.max(0, -footer.savedTokens) };
};

// --- the turn experiments -------------------------------------------------------------------------------------

/* WHAT EACH METRIC IS A QUANTITY OF, said in the reader's words rather than the ledger's. The unit is never
 * decoration: "↓12%" alone does not say twelve percent of what, and the search experiment reports two
 * readings at once whose whole difference is which of these they count.
 *
 * `searches per turn` and `searches before the first file` are deliberately near-identical phrases. They ARE
 * near-identical quantities, the second is a prefix of the first, and naming them as if they were unrelated
 * would invite a reader to treat two readings of one experiment as two findings. */
const METRIC_UNITS = {
    proseChars: `prose written per turn`,
    searchCalls: `searches per turn`,
    openingSearches: `searches before the first file`,
} satisfies Record<TurnMetricReading["metric"], string>;

// An arm's mean in the metric's own unit. Prose compact (a turn writes thousands of characters), searches to
// the tenth (a turn runs a handful, and the delta between two arms is a fraction of one), the same split the
// daemon rounds on, in turn-experiments.ts.
export const meanLabel = (reading: TurnMetricReading, value: number): string =>
    reading.metric === `proseChars` ? `${formatCompact(value)} chars/turn` : `${value} searches/turn`;

// What the mechanism was worth over this window, in whole units. Searches are rounded to one: the figure is a
// count of things that either happened or didn't, and a mean difference's spare decimal is arithmetic, not a
// fifth of a search anybody ran.
const savedLabel = (reading: TurnMetricReading): string =>
    reading.metric === `proseChars` ? `${formatCompact(reading.saved ?? 0)} chars` : `${Math.round(reading.saved ?? 0)} searches`;

/* Both A/B cards' HEADLINE, from one function, because the two experiments differ in nothing a reader cares
 * about: each states a verdict, what the verdict is a verdict about, and the one line the figure is worthless
 * without. Same three slots either way.
 *
 * A verdict is a WORD when there is no figure. "Measuring" sitting at the same size, in the same place, as
 * "↓12%" is what lets the savings row be read in one scan, the version this replaces left the headline slot
 * holding a methodology tag ("terse steer · A/B") and buried the actual state four lines down in 11px prose,
 * so the only way to learn an experiment had no answer yet was to read a paragraph. */
export interface ExperimentVerdict {
    readonly value: string;
    readonly unit: string;
    // Down is the direction that saves work, so a measured saving is the only thing that earns success. An
    // increase is stated, not alarmed about: an experiment reporting the mechanism cost more is working.
    readonly tone: "success" | "content" | "muted";
    // The qualification the figure is meaningless without, its margin and what it bought, or how far the
    // shorter arm still has to run. Never optional: a delta without one reads differently tomorrow.
    readonly detail: string;
}

// ONE READING'S verdict, and only what that reading can answer for.
export const readingVerdict = (
    reading: TurnMetricReading,
    minTurns: number,
    sampleUnit: NonNullable<TurnExperiment["sampleUnit"]> = `turns`,
): ExperimentVerdict => {
    const unit = METRIC_UNITS[reading.metric];

    // The margin arrives as soon as both arms clear minTurns; the delta waits for the margin to exclude zero.
    // Two states, two shortfalls, and neither is allowed to borrow the other's headline.
    if (reading.marginPct === undefined) {
        const shortfall = Math.max(minTurns - reading.on.turns, minTurns - reading.off.turns);
        return { value: `Measuring`, unit, tone: `muted`, detail: `needs ${minTurns} ${sampleUnit} per arm — ${shortfall} more on the shorter one` };
    }
    /* MEASURED, AND THE ANSWER IS "NOT YET DISTINGUISHABLE FROM NOTHING". A separate verdict from "Measuring"
     * because it is a different fact, the arms are big enough, the spread is simply wider than the effect,
     * and the reader's next move differs: one waits, the other asks whether the mechanism is worth its keep.
     * The resolution is what it gets instead of a number, since that is the honest content of the reading. */
    if (reading.deltaPct === undefined) {
        /* "Keep collecting" for how long, though. Without a figure the reader cannot tell an experiment three
         * days from an answer apart from one whose holdout is too small to ever produce one, and both look like
         * patience. The daemon's estimate is coarse by construction (turn-experiments.ts) so it is rounded hard
         * and said as an order of magnitude. */
        const wait =
            reading.controlTurnsNeeded === undefined
                ? `keep collecting`
                : `~${formatCompact(reading.controlTurnsNeeded)} more control ${sampleUnit} would settle it`;
        /* SAME GRAMMAR AS THE MEASURED VERDICT'S DETAIL below, margin first, then the one thing that qualifies
         * it, joined by a middot. It used to read "anything real is inside ±35.1pp (95%) — ~5.8K more control
         * turns would settle it": a clause, a figure and a second clause in one breath, which is exactly the
         * run-on the settings rows could not lay out. The framing it drops is carried by the headline this
         * detail sits under ("No effect measurable in prose written per turn"), so nothing is lost. */
        return { value: `No effect`, unit: `measurable in ${unit}`, tone: `muted`, detail: `±${reading.marginPct}pp (95%) · ${wait}` };
    }

    return {
        // Direction is spelled with an arrow AND a sign, so it never rests on colour.
        value: `${reading.deltaPct < 0 ? `↓` : `↑`}${Math.abs(reading.deltaPct)}%`,
        unit,
        tone: reading.deltaPct < 0 ? `success` : `content`,
        detail: `±${reading.marginPct}pp (95%)${(reading.saved ?? 0) > 0 ? ` · ~${savedLabel(reading)} saved in this range` : ``}`,
    };
};

/* Every reading an experiment carries, split the way a card reads it: the `headline` fills the verdict slot at
 * the top, and `also` stacks under the evidence. Split here rather than by index at the call site, because
 * "there is always exactly one headline" is a fact about experiments and not something each screen should
 * rediscover with a `[0]`.
 *
 * `undefined` ⇒ the experiment isn't running at all (its flag off, or no holdout set), which is a verdict like
 * any other and gets the same three slots, so a card cannot end up saying "Off" in a shape the measured
 * states don't share. */
export const verdictsOf = (experiment: TurnExperiment | undefined): { headline: ExperimentVerdict; also: ExperimentVerdict[] } => {
    if (experiment === undefined) {
        return { headline: { value: `Off`, unit: `not being measured`, tone: `muted`, detail: `` }, also: [] };
    }
    const [first, ...rest] = experiment.metrics;
    return {
        headline: readingVerdict(first, experiment.minTurns, experiment.sampleUnit),
        also: rest.map((reading) => readingVerdict(reading, experiment.minTurns, experiment.sampleUnit)),
    };
};

// What each toggleable cleaner saved in this window, for the readout under its switch. Absent id ⇒ the cleaner
// hasn't run (or hasn't saved anything) in the window, which the row states rather than printing a zero.
export const savedByCleaner = (input: InputSavings | undefined): Map<string, number> =>
    new Map((input?.perCleaner ?? []).filter((stage) => stage.savedTokens > 0).map((stage) => [stage.id, stage.savedTokens]));
