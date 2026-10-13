<script setup lang="ts">
import { computed } from "vue";
import { type Tip, toneWash } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { commitPercent } from "./numberInputs";
import type { Outcome, ResultRow, ResultTable } from "./experimentReadings";
import { formatCompact, formatCount, formatDayMonth, formatFixed, formatPercent } from "@intentic/ui/format";

// The measured half of a setting that holds some of its work back for comparison (iq search, the project map, the field
// notes, the guidance form, the output cleaners). One table, every reading a row of the same shape: what it counts, each
// group's average, and the change. A clear difference is always in the last column, in the same colour, whichever
// reading found it. The statistics behind a row (its likely range, the samples it stands on) are a hover away.
// A row with no answer yet shows no averages: two figures side by side read as a result whatever colour they are, and on
// 16 conversations against 19 one long session moved a mean from 36 to 84. It says how far along it is instead. When a
// restarted comparison has no answer at all yet, the last one that did stands under it, with its dates.
// The comparison share closes the block because it configures the method, not the setting.

const t = useT();

const {
    table,
    percent,
    note,
    onLabel,
    offLabel,
    disabled = false,
} = defineProps<{
    /** Undefined until the daemon has an experiment to report. */
    table: ResultTable | undefined;
    /** Share of work held back for comparison, 0-100. */
    percent: number;
    /** Finishes the sentence the percent box starts: "10% of conversations run without iq". */
    note: string;
    /** Column heads in the reader's words: "With iq" / "Without", "Short" / "Long". */
    onLabel: string;
    offLabel: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{ commit: [fraction: number] }>();

// A share is said as a percentage of the sample, a count per sample to a tenth.
const average = (value: number | undefined, share: boolean): string =>
    value === undefined ? `–` : share ? formatPercent(value * 100) : formatFixed(value, 1);

// The cleaners' one row is an amount of text, not a count of calls: "less", not "fewer".
const change = (row: ResultRow, outcome: Outcome & { kind: `lower` | `higher` }): string =>
    outcome.kind === `higher`
        ? `↑ ${t(`sandbox.measurementPanel.more`, { pct: outcome.pct })}`
        : `↓ ${row.key === `outputReached` ? t(`sandbox.measurementPanel.less`, { pct: outcome.pct }) : t(`sandbox.measurementPanel.fewer`, { pct: outcome.pct })}`;

interface Line {
    readonly key: string;
    readonly label: string;
    readonly on: string;
    readonly off: string;
    readonly result: string;
    /** Whether the row found a difference; an open one greys its figures, since they are not yet a finding. */
    readonly settled: boolean;
    /** No answer of any kind yet, so its averages are withheld. */
    readonly early: boolean;
    readonly mark: string;
    readonly tip: Tip | undefined;
}

/** The table's body: the current rows, then the earlier comparison's under a heading of its own. */
type Entry = { readonly kind: `line`; readonly line: Line } | { readonly kind: `heading`; readonly key: string; readonly text: string };

// A measured change is a tinted chip, the one filled thing in the table, so a win is found by colour AND shape in the
// same column on every row; an open row is plain grey words. The chip's padding is pulled back into the gutter so its
// text still lines up with the column head.
const MARKS = {
    lower: toneWash(`success`, `-ml-1.5 rounded-sm px-1.5 py-px font-medium`),
    higher: toneWash(`warning`, `-ml-1.5 rounded-sm px-1.5 py-px font-medium`),
    unclear: `text-subtle`,
    early: `text-subtle`,
} as const satisfies Record<Outcome["kind"], string>;

// Each group's own samples behind the row, as figures on its card: a row can stand on fewer than the table's count.
const samplesOf = (row: ResultRow): Tip["rows"] =>
    row.samples === undefined
        ? undefined
        : [
              { label: onLabel, value: formatCount(row.samples.on) },
              { label: offLabel, value: formatCount(row.samples.off) },
          ];

const tipOf = (row: ResultRow, unit: ResultTable["unit"]): Tip | undefined => {
    const { outcome } = row;
    const rows = samplesOf(row);
    if (outcome.kind === `early`) {
        return outcome.need === undefined || rows === undefined ? undefined : { title: t(`sandbox.measurementPanel.needsEach`, { need: outcome.need }), rows };
    }
    if (outcome.kind === `unclear`) {
        return outcome.within === undefined
            ? undefined
            : {
                  title: t(`sandbox.measurementPanel.anyDifferenceUnder`, { within: outcome.within }),
                  rows,
                  note:
                      outcome.needed === undefined || unit === `commands`
                          ? undefined
                          : t(`sandbox.measurementPanel.moreWouldSettle.${unit}`, { needed: formatCompact(outcome.needed) }),
              };
    }
    if (outcome.low === undefined || outcome.high === undefined) {
        return undefined;
    }
    const range = { low: outcome.low, high: outcome.high };
    return {
        title: outcome.kind === `lower` ? t(`sandbox.measurementPanel.likelyFewer`, range) : t(`sandbox.measurementPanel.likelyMore`, range),
        rows,
        note:
            outcome.saved === undefined || row.key === `outputReached`
                ? undefined
                : t(`sandbox.measurementPanel.savedSoFar.${row.key}`, { count: formatCount(outcome.saved) }),
    };
};

const resultOf = (outcome: Outcome, row: ResultRow): string => {
    switch (outcome.kind) {
        case `lower`:
        case `higher`:
            return change(row, outcome);
        case `unclear`:
            return t(`sandbox.measurementPanel.noClearDifference`);
        case `early`:
            return outcome.have === undefined || outcome.need === undefined
                ? t(`sandbox.measurementPanel.tooEarly`)
                : t(`sandbox.measurementPanel.earlyProgress`, { have: formatCount(outcome.have), need: outcome.need });
    }
};

const lineOf = (row: ResultRow, unit: ResultTable["unit"]): Line => {
    const { outcome } = row;
    const early = outcome.kind === `early`;
    const share = row.share === true;
    return {
        key: row.key,
        label: t(`sandbox.measurementPanel.metric.${row.key}`),
        on: early ? `–` : average(row.on, share),
        off: early ? `–` : average(row.off, share),
        result: resultOf(outcome, row),
        settled: outcome.kind === `lower` || outcome.kind === `higher`,
        early,
        // Only a measured drop earns green; a measured rise is a finding to act on, so it is not left grey either.
        mark: MARKS[outcome.kind],
        tip: tipOf(row, unit),
    };
};

const lines = computed<Line[]>(() => (table?.rows ?? []).map((row) => lineOf(row, table?.unit ?? `turns`)));

// The earlier comparison only while nothing in this one has answered: once one row has, this one speaks for itself.
const entries = computed<Entry[]>(() => {
    const current = lines.value.map((line): Entry => ({ kind: `line`, line }));
    const previous = table?.previous;
    if (previous === undefined || !lines.value.every((line) => line.early)) {
        return current;
    }
    const heading: Entry = {
        kind: `heading`,
        key: `previous`,
        text: t(`sandbox.measurementPanel.lastResult`, { from: formatDayMonth(previous.from), to: formatDayMonth(previous.to) }),
    };
    return [
        ...current,
        heading,
        ...previous.rows.map((row): Entry => ({ kind: `line`, line: { ...lineOf(row, table?.unit ?? `turns`), key: `previous-${row.key}` } })),
    ];
});

const anyEarly = computed<boolean>(() => lines.value.some((line) => line.early));
</script>

<template>
    <!-- No background or border of its own: the row's `#below` spine and the group's `divide-y` already provide the boundaries.
         Capped: on a wide pane an uncapped table strands its figures a hand's width from the names they belong to. -->
    <div class="flex min-w-0 max-w-xl flex-col gap-3">
        <!-- Fixed columns, not sized to content: preserve comparisons in a local scroller rather than crushing the
             effect column when the pane is narrow. Keyboard readers can reach and scroll the same region. -->
        <div
            v-if="table !== undefined"
            role="region"
            :aria-label="`${onLabel} / ${offLabel}`"
            tabindex="0"
            class="min-w-0 max-w-full overflow-x-auto"
        >
            <table class="w-full min-w-[32rem] table-fixed border-collapse text-xs tabular-nums">
                <colgroup>
                    <col />
                    <col class="w-20" />
                    <col class="w-20" />
                    <col class="w-40" />
                </colgroup>
                <thead>
                    <tr class="text-2xs text-subtle">
                        <th scope="col" class="pb-1.5 text-left font-medium">{{ t(`sandbox.measurementPanel.effect`) }}</th>
                        <th scope="col" class="pb-1.5 pl-4 text-right font-medium">{{ onLabel }}</th>
                        <th scope="col" class="pb-1.5 pl-4 text-right font-medium">{{ offLabel }}</th>
                        <th scope="col" class="pb-1.5 pl-6 text-left font-medium">{{ t(`sandbox.measurementPanel.change`) }}</th>
                    </tr>
                </thead>
                <tbody>
                    <!-- How much each column stands on, as a row of the table rather than an "n=" beside every figure. -->
                    <tr class="border-t border-line-subtle text-subtle">
                        <th scope="row" class="py-1.5 text-left font-normal">{{ t(`sandbox.measurementPanel.sample.${table.unit}`) }}</th>
                        <td class="py-1.5 pl-4 text-right">{{ formatCount(table.on) }}</td>
                        <td class="py-1.5 pl-4 text-right">{{ formatCount(table.off) }}</td>
                        <td class="py-1.5 pl-6" />
                    </tr>
                    <template v-for="entry in entries" :key="entry.kind === `line` ? entry.line.key : entry.key">
                        <!-- The earlier comparison's heading spans the table, so its rows stay in the columns they belong to. -->
                        <tr v-if="entry.kind === `heading`" class="border-t border-line-subtle">
                            <th scope="colgroup" colspan="4" class="pb-1 pt-3 text-left text-2xs font-medium text-subtle">{{ entry.text }}</th>
                        </tr>
                        <tr v-else class="border-t border-line-subtle">
                            <th scope="row" class="py-1.5 pr-2 text-left font-normal text-muted">{{ entry.line.label }}</th>
                            <td class="py-1.5 pl-4 text-right" :class="entry.line.settled ? `text-content` : `text-muted`">{{ entry.line.on }}</td>
                            <td class="py-1.5 pl-4 text-right" :class="entry.line.settled ? `text-content` : `text-muted`">{{ entry.line.off }}</td>
                            <td class="whitespace-nowrap py-1.5 pl-6 text-left">
                                <!-- The statistics behind the words (the likely range, the samples the row stands on) are a hover
                                 away for whoever asks, not printed for everyone; a dotted underline on an open row says so. -->
                                <span
                                    v-tooltip.top="entry.line.tip"
                                    :tabindex="entry.line.tip === undefined ? undefined : 0"
                                    class="inline-block"
                                    :class="[
                                        entry.line.mark,
                                        entry.line.tip === undefined ? `` : `cursor-help`,
                                        entry.line.tip !== undefined && !entry.line.settled
                                            ? `underline decoration-line-strong decoration-dotted underline-offset-3`
                                            : ``,
                                    ]"
                                    >{{ entry.line.result }}</span
                                >
                            </td>
                        </tr>
                    </template>
                </tbody>
            </table>
        </div>
        <p v-else class="text-xs text-subtle">{{ t(`sandbox.measurementPanel.noResultsYet`) }}</p>

        <!-- The rule said once for the whole table; how far along each open row is, its own Change cell says. -->
        <p v-if="table?.minimum !== undefined && anyEarly" class="text-2xs text-subtle">
            {{ t(`sandbox.measurementPanel.resultsAppearAt`, { minimum: table.minimum }) }}
        </p>

        <!-- The holdout as the sentence it is: a label naming it as a setting, then the box, then `note`. Unfilled,
             unlike a form's fields, so the one input in a block of figures does not read as the loudest figure. -->
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line-subtle pt-3 text-xs text-muted">
            <span class="text-subtle">{{ t(`sandbox.measurementPanel.comparisonGroup`) }}</span>
            <span class="ui-field-shell inline-flex items-center gap-0.5 bg-transparent px-1.5 py-0.5">
                <input
                    type="number"
                    min="0"
                    max="100"
                    :value="percent"
                    :disabled="disabled"
                    :aria-label="t(`sandbox.measurementPanel.controlGroupPercentage`)"
                    class="field-bare w-7 p-0 text-right text-xs tabular-nums"
                    @change="(event: Event) => commitPercent(event, percent, (fraction: number) => emit(`commit`, fraction))"
                />
                <span class="text-2xs text-subtle">%</span>
            </span>
            {{ note }}
        </p>
    </div>
</template>
