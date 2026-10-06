import type { FigureAccent } from "@intentic/ui/markdown";
import { seriesColor } from "@intentic/ui/series";
import type { InputSavings } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// Every number and mark on the Savings surfaces, as pure functions over the daemon's savings report (same split
// as usageChart.ts): the arithmetic under a claim like "89% saved" is testable without mounting a component. Cleaner
// savings are exact, each command has its own raw baseline.

// mechanism identity

// Every toggleable cleaner id and label, in the order of @intentic/output-cleaners' CLEANERS (keep in sync). Shared by
// the Agent tab's switches and this chart's labels, so a mechanism is never named differently on two screens.
export const cleanerOptions = () =>
    [
        { id: `pnpm`, label: `pnpm` },
        { id: `apt`, label: `apt` },
        { id: `test`, label: t(`sandbox.savingsChart.testRunners`) },
        { id: `diff`, label: t(`sandbox.savingsChart.generatedFileDiffs`) },
        { id: `ls`, label: t(`sandbox.savingsChart.directoryListings`) },
        { id: `files`, label: t(`sandbox.savingsChart.fileLists`) },
        { id: `hits`, label: t(`sandbox.savingsChart.searchHits`) },
        { id: `dedup`, label: t(`sandbox.savingsChart.dedupeRepeats`) },
        { id: `wide`, label: t(`sandbox.savingsChart.machineGeneratedBlobs`) },
        { id: `cap`, label: t(`sandbox.savingsChart.headTailCap`) },
        { id: `redact`, label: t(`sandbox.savingsChart.redactSecrets`) },
        { id: `cache`, label: t(`sandbox.savingsChart.collapseRepeats`) },
    ] as const;

export const allCleanerIds = (): readonly string[] => cleanerOptions().map((cleaner) => cleaner.id);

// Stages with no settings switch (unconditional parts of the filter). Named rather than folded into "other" so a
// reader can tell "not listed" from "not yours to turn off".
// Built when read, so the labels follow a language switch.
const fixedStageLabels = (): Record<string, string> => ({
    ansi: t(`sandbox.savingsChart.terminalEscapes`),
    failtail: t(`sandbox.savingsChart.failureTailCap`),
    footer: t(`sandbox.savingsChart.retrievalFooter`),
    guard: t(`sandbox.savingsChart.refusedOutputGrew`),
});

export const stageLabel = (id: string): string => cleanerOptions().find((cleaner) => cleaner.id === id)?.label ?? fixedStageLabels()[id] ?? id;

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
            label: t(`sandbox.words.more`, { count: tail.length }),
            tokens: tail.reduce((sum, stage) => sum + stage.savedTokens, 0),
            color: `var(--color-series-other)`,
            kind: `saved`,
        });
    }
    // Remainder = raw output minus removed segments, keeping the bar's sum equal to the raw total.
    const removed = segments.reduce((sum, segment) => sum + segment.tokens, 0);
    segments.push({
        key: `reached`,
        label: t(`sandbox.words.reachedAssistant`),
        tokens: Math.max(0, input.rawTokens - removed),
        color: `var(--color-content-subtle)`,
        kind: `reached`,
    });

    return { segments, rawTokens: input.rawTokens, footerTokens: footer === undefined ? 0 : Math.max(0, -footer.savedTokens) };
};

// Per-cleaner savings this window; a missing id means it hasn't run or saved anything (stated, not zeroed).
export const savedByCleaner = (input: InputSavings | undefined): Map<string, number> =>
    new Map((input?.perCleaner ?? []).filter((stage) => stage.savedTokens > 0).map((stage) => [stage.id, stage.savedTokens]));
