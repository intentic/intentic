import type { FigureAccent } from "@intentic/ui/markdown";
import { seriesColor } from "@intentic/ui/series";
import type { InputSavings, TurnExperiment } from "@intentic/sandbox-contract";
import { formatCompact } from "./usageChart";

/* Every number and every mark on the Savings surfaces, as pure functions over the daemon's savings report —
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

// Stages the ledger attributes savings to that have NO switch on the settings page — they are unconditional
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
// width (usageChart.ts PROVIDER_SERIES) — a sixth hue would be one this design system has never checked for
// adjacent-pair contrast.
const SLOTS = 5;

// The palette's slots, named directly. This used to be a list of PROVIDER names — claude, codex, kimi… — fed
// through the provider→slot lookup purely to arrive back at slots 1–5, because slot→colour was not reachable
// on its own. It is now (`seriesColor` is exported), so the detour is gone: nothing here is about providers.
const SLOTS_BY_RANK = [`1`, `2`, `3`, `4`, `5`] as const satisfies readonly FigureAccent[];

export interface SavingsSegment {
    readonly key: string;
    readonly label: string;
    readonly tokens: number;
    readonly color: string;
    // "reached" is what the model was actually handed — not a mechanism, and coloured so it can never be read
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
    // its own line instead — it is the price of the trimming being reversible, and hiding a cost inside a
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
    // What reached the model, as the remainder — which is exactly the emitted total minus the footers the
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

/* Both A/B cards' HEADLINE, from one function, because the two experiments differ in nothing a reader cares
 * about: each states a verdict, what the verdict is a verdict about, and the one line the figure is worthless
 * without. Same three slots either way.
 *
 * A verdict is a WORD when there is no figure. "Measuring" sitting at the same size, in the same place, as
 * "↓12%" is what lets the savings row be read in one scan — the version this replaces left the headline slot
 * holding a methodology tag ("terse steer · A/B") and buried the actual state four lines down in 11px prose,
 * so the only way to learn an experiment had no answer yet was to read a paragraph. */
export interface ExperimentVerdict {
    readonly value: string;
    readonly unit: string;
    // Down is the direction that saves money, so a measured saving is the only thing that earns success. An
    // increase is stated, not alarmed about: an experiment reporting the mechanism cost more is working.
    readonly tone: "success" | "content" | "muted";
    // The qualification the figure is meaningless without — its margin and what it bought, or how far the
    // shorter arm still has to run. Never optional: a delta without one reads differently tomorrow.
    readonly detail: string;
}

// `undefined` ⇒ the experiment isn't running at all (its flag off, or no holdout set), which is a verdict like
// any other and gets the same three slots. Handled here rather than by a second function at the call site, so
// the card cannot end up saying "Off" in a shape the measured states don't share.
export const verdictOf = (experiment: TurnExperiment | undefined): ExperimentVerdict => {
    if (experiment === undefined) {
        return { value: `Off`, unit: `not being measured`, tone: `muted`, detail: `` };
    }

    const unit = experiment.metric === `costUsd` ? `cost per turn` : `prose written per turn`;
    // What the arm was worth is a claim about the turns the mechanism REACHED, and pre-injection reaches only
    // some of the arm it is assigned (a prompt that named its own file is retrieved for and finds nothing worth
    // prepending). Said plainly wherever a figure appears, because a delta over a four-fifths-untreated arm is
    // a fifth of the delta over the treated ones and a reader has no way to know that from the number.
    const dilution = experiment.deliveredPct === undefined ? `` : ` · note actually landed on ${experiment.deliveredPct}% of the treated arm`;

    // The margin arrives as soon as both arms clear minTurns; the delta waits for the margin to exclude zero.
    // Two states, two shortfalls, and neither is allowed to borrow the other's headline.
    if (experiment.marginPct === undefined) {
        const shortfall = Math.max(experiment.minTurns - experiment.on.turns, experiment.minTurns - experiment.off.turns);
        return {
            value: `Measuring`,
            unit,
            tone: `muted`,
            detail: `needs ${experiment.minTurns} turns per arm — ${shortfall} more on the shorter one${dilution}`,
        };
    }
    /* MEASURED, AND THE ANSWER IS "NOT YET DISTINGUISHABLE FROM NOTHING". A separate verdict from "Measuring"
     * because it is a different fact — the arms are big enough, the spread is simply wider than the effect —
     * and the reader's next move differs: one waits, the other asks whether the mechanism is worth its keep.
     * The resolution is what it gets instead of a number, since that is the honest content of the reading. */
    if (experiment.deltaPct === undefined) {
        return {
            value: `No effect`,
            unit: `measurable in ${unit}`,
            tone: `muted`,
            detail: `anything real is inside ±${experiment.marginPct}pp (95%) — keep collecting${dilution}`,
        };
    }

    // Dollars to the cent, characters compact: a turn costs cents and writes thousands of characters
    // respectively, the same split the daemon rounds on (turn-experiments.ts).
    const saved = experiment.metric === `costUsd` ? `$${(experiment.saved ?? 0).toFixed(2)}` : `${formatCompact(experiment.saved ?? 0)} chars`;
    return {
        // Direction is spelled with an arrow AND a sign, so it never rests on colour.
        value: `${experiment.deltaPct < 0 ? `↓` : `↑`}${Math.abs(experiment.deltaPct)}%`,
        unit,
        tone: experiment.deltaPct < 0 ? `success` : `content`,
        detail: `±${experiment.marginPct}pp (95%)${(experiment.saved ?? 0) > 0 ? ` · ~${saved} saved in this range` : ``}${dilution}`,
    };
};

// What each toggleable cleaner saved in this window, for the readout under its switch. Absent id ⇒ the cleaner
// hasn't run (or hasn't saved anything) in the window, which the row states rather than printing a zero.
export const savedByCleaner = (input: InputSavings | undefined): Map<string, number> =>
    new Map((input?.perCleaner ?? []).filter((stage) => stage.savedTokens > 0).map((stage) => [stage.id, stage.savedTokens]));
