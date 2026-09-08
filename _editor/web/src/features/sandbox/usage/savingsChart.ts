import type { FigureAccent } from "@intentic/ui/markdown";
import { seriesColor } from "@intentic/ui/series";
import type { InputSavings, TurnExperiment, TurnMetricReading } from "@intentic/sandbox-contract";
import { formatCompact } from "./usageChart";

// Every number and mark on the Savings surfaces, as pure functions over the daemon's savings report (same split
// as usageChart.ts): the arithmetic under a claim like "89% saved" is testable without mounting a component. Cleaner
// savings are exact, each command has its own raw baseline.

// mechanism identity

// Every toggleable cleaner id and label, in bin/cleaners.mjs CLEANERS' order (keep in sync). Shared by the Agent
// tab's switches and this chart's labels, so a mechanism is never named differently on two screens.
export const CLEANER_OPTIONS = [
    { id: `pnpm`, label: `pnpm` },
    { id: `apt`, label: `apt` },
    { id: `test`, label: `test runners` },
    { id: `ls`, label: `directory listings` },
    { id: `files`, label: `file lists` },
    { id: `hits`, label: `search hits` },
    { id: `dedup`, label: `dedupe repeats` },
    { id: `cap`, label: `head/tail cap` },
    { id: `redact`, label: `redact secrets` },
    { id: `cache`, label: `collapse repeats` },
] as const;

export const ALL_CLEANER_IDS: readonly string[] = CLEANER_OPTIONS.map((cleaner) => cleaner.id);

// Stages with no settings switch (unconditional parts of the filter). Named rather than folded into "other" so a
// reader can tell "not listed" from "not yours to turn off".
const FIXED_STAGE_LABELS: Record<string, string> = {
    ansi: `terminal escapes`,
    failtail: `failure tail cap`,
    footer: `retrieval footer`,
    guard: `refused (output grew)`,
};

export const stageLabel = (id: string): string => CLEANER_OPTIONS.find((cleaner) => cleaner.id === id)?.label ?? FIXED_STAGE_LABELS[id] ?? id;

// the composition bar

// Slots before the tail folds; five is the validated palette's width (usageChart.ts PROVIDER_SERIES).
const SLOTS = 5;

// Palette slots named directly, via `seriesColor`; unrelated to providers.
const SLOTS_BY_RANK = [`1`, `2`, `3`, `4`, `5`] as const satisfies readonly FigureAccent[];

export interface SavingsSegment {
    readonly key: string;
    readonly label: string;
    readonly tokens: number;
    readonly color: string;
    // "reached" is what the model was actually handed, not a mechanism; colored so it reads as neither.
    readonly kind: "saved" | "reached";
}

export interface Composition {
    // Segments sum to `rawTokens`, in draw order: top mechanisms, folded tail, then what reached the assistant.
    readonly segments: readonly SavingsSegment[];
    readonly rawTokens: number;
    // Tokens the filter adds back as pointers; already inside the total, so disclosed separately, not stacked.
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
        // Colored by rank, not identity (unlike provider charts): more mechanisms exist than checked slots.
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
    // Remainder = raw output minus removed segments, keeping the bar's sum equal to the raw total.
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

// the turn experiments

// Metric labels in three lengths (unit/mean/total) for different display spots; never decoration alone.
// `searchCalls`/`openingSearches` are worded near-identically (one is a prefix of the other); the map metrics are not,
// and must not be conflated (compliance vs. outcome).
const METRICS = {
    searchCalls: { unit: `searches per turn`, mean: `searches/turn`, total: `searches` },
    openingSearches: { unit: `searches before the first file`, mean: `searches/turn`, total: `searches` },
    openingListings: { unit: `directory listings opening a conversation`, mean: `listings/turn`, total: `listings` },
    callsBeforeTarget: { unit: `calls before the file it edits`, mean: `calls`, total: `calls` },
} satisfies Record<TurnMetricReading["metric"], { unit: string; mean: string; total: string }>;

export const meanLabel = (reading: TurnMetricReading, value: number): string => `${value} ${METRICS[reading.metric].mean}`;

const savedLabel = (reading: TurnMetricReading): string => `${Math.round(reading.saved ?? 0)} ${METRICS[reading.metric].total}`;

// One shape for both experiments' headline: a verdict, what it's about, and the qualifying detail. A verdict can
// be a word ("Measuring") at the same size as a figure, so the row reads in one scan.
export interface ExperimentVerdict {
    readonly value: string;
    readonly unit: string;
    // Only a measured saving earns `success`; an increase is stated plainly, not alarmed about.
    readonly tone: "success" | "content" | "muted";
    // Qualifier the figure needs to mean anything (margin, payoff, or shortfall); never optional.
    readonly detail: string;
}

// ONE READING'S verdict, and only what that reading can answer for.
export const readingVerdict = (
    reading: TurnMetricReading,
    minTurns: number,
    sampleUnit: NonNullable<TurnExperiment["sampleUnit"]> = `turns`,
): ExperimentVerdict => {
    const unit = METRICS[reading.metric].unit;

    // Margin arrives once both arms clear minTurns; the delta waits for the margin to exclude zero.
    if (reading.marginPct === undefined) {
        const shortfall = Math.max(minTurns - reading.on.turns, minTurns - reading.off.turns);
        return { value: `Measuring`, unit, tone: `muted`, detail: `needs ${minTurns} ${sampleUnit} per arm, ${shortfall} more on the shorter one` };
    }
    // Distinct from "Measuring": the arms are big enough, the effect is just smaller than the noise, and the
    // reader's next move differs (wait vs. question the mechanism).
    if (reading.deltaPct === undefined) {
        // Rounded hard to an order of magnitude: the daemon's estimate is coarse by construction
        // (turn-experiments.ts), and without one a near-answer looks identical to a holdout too small to ever resolve.
        const wait =
            reading.controlTurnsNeeded === undefined
                ? `keep collecting`
                : `~${formatCompact(reading.controlTurnsNeeded)} more control ${sampleUnit} would settle it`;
        // Same grammar as the measured verdict's detail: margin, then the qualifier, joined by a middot. The framing is
        // carried by the headline above it, so nothing is lost by dropping it here.
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

// Splits an experiment's readings into the card's headline slot and the rest, so "exactly one headline" isn't
// rediscovered per call site with `[0]`. `undefined` (not running) is a verdict like any other, in the same three-slot
// shape.
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

// Per-cleaner savings this window; a missing id means it hasn't run or saved anything (stated, not zeroed).
export const savedByCleaner = (input: InputSavings | undefined): Map<string, number> =>
    new Map((input?.perCleaner ?? []).filter((stage) => stage.savedTokens > 0).map((stage) => [stage.id, stage.savedTokens]));
