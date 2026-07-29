import type { InputSavings } from "@intentic/sandbox-contract";
import { seriesColor } from "./usageChart";

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
    { id: `npm`, label: `npm / npx` },
    { id: `pnpm`, label: `pnpm` },
    { id: `yarn`, label: `yarn` },
    { id: `docker`, label: `docker` },
    { id: `git`, label: `git` },
    { id: `pip`, label: `pip` },
    { id: `apt`, label: `apt` },
    { id: `test`, label: `test runners` },
    { id: `lint`, label: `tsc / eslint` },
    { id: `ls`, label: `ls listings` },
    { id: `gh`, label: `gh CLI` },
    { id: `build`, label: `cargo / go` },
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
};

export const stageLabel = (id: string): string => CLEANER_OPTIONS.find((cleaner) => cleaner.id === id)?.label ?? FIXED_STAGE_LABELS[id] ?? id;

// --- the composition bar ------------------------------------------------------------------------------------

// How many mechanisms get their own slot before the tail is folded. Five is the validated categorical palette's
// width (usageChart.ts PROVIDER_SERIES) — a sixth hue would be one this design system has never checked for
// adjacent-pair contrast.
const SLOTS = 5;

// The keys whose slots the validated palette is defined in terms of — reached through the one function that
// owns that mapping (seriesColor) rather than interpolating --color-series-N by hand in a second file.
const PALETTE_KEYS = [`claude`, `codex`, `kimi`, `grok`, `gemini`] as const;

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
        // Slot by RANK, unlike the provider charts where colour follows the entity for good. There are ~19
        // possible mechanisms and five checked slots, so an entity-stable mapping isn't available; the ranked
        // list beside the bar carries identity, and every segment names itself on hover.
        color: seriesColor(PALETTE_KEYS[index] ?? ``),
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

// What each toggleable cleaner saved in this window, for the readout under its switch. Absent id ⇒ the cleaner
// hasn't run (or hasn't saved anything) in the window, which the row states rather than printing a zero.
export const savedByCleaner = (input: InputSavings | undefined): Map<string, number> =>
    new Map((input?.perCleaner ?? []).filter((stage) => stage.savedTokens > 0).map((stage) => [stage.id, stage.savedTokens]));
