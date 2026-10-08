<script setup lang="ts">
import { computed } from "vue";
import { type Tip, toneWash } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { commitPercent } from "./numberInputs";
import { type Outcome, type ResultRow, type ResultTable, shortfallOf } from "./experimentReadings";
import { formatCompact, formatCount, formatFixed } from "@intentic/ui/format";

// The measured half of a setting that holds some of its work back for comparison (iq search, the project map, the field
// notes, the guidance form, the output cleaners). One table, every reading a row of the same shape: what it counts, each
// group's average, and the change. A clear difference is always in the last column, in the same colour, whichever
// reading found it. The statistics behind a row (its likely range, the sample still owed) are a hover away, in words.
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

const average = (value: number | undefined): string => (value === undefined ? `–` : formatFixed(value, 1));

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
    /** Whether the row reached an answer; an open one greys its figures, since they are not yet a finding. */
    readonly settled: boolean;
    readonly mark: string;
    readonly tip: Tip | undefined;
}

// A measured change is a tinted chip, the one filled thing in the table, so a win is found by colour AND shape in the
// same column on every row; an open row is plain grey words. The chip's padding is pulled back into the gutter so its
// text still lines up with the column head.
const MARKS = {
    lower: toneWash(`success`, `-ml-1.5 rounded-sm px-1.5 py-px font-medium`),
    higher: toneWash(`warning`, `-ml-1.5 rounded-sm px-1.5 py-px font-medium`),
    unclear: `text-subtle`,
    early: `text-subtle`,
} as const satisfies Record<Outcome["kind"], string>;

const tipOf = (row: ResultRow, unit: ResultTable["unit"]): Tip | undefined => {
    const { outcome } = row;
    if (outcome.kind === `unclear`) {
        return outcome.within === undefined
            ? undefined
            : {
                  title: t(`sandbox.measurementPanel.anyDifferenceUnder`, { within: outcome.within }),
                  note:
                      outcome.needed === undefined || unit === `commands`
                          ? undefined
                          : t(`sandbox.measurementPanel.moreWouldSettle.${unit}`, { needed: formatCompact(outcome.needed) }),
              };
    }
    if (outcome.kind === `early` || outcome.low === undefined || outcome.high === undefined) {
        return undefined;
    }
    const range = { low: outcome.low, high: outcome.high };
    return {
        title: outcome.kind === `lower` ? t(`sandbox.measurementPanel.likelyFewer`, range) : t(`sandbox.measurementPanel.likelyMore`, range),
        note:
            outcome.saved === undefined || row.key === `outputReached`
                ? undefined
                : t(`sandbox.measurementPanel.savedSoFar.${row.key}`, { count: formatCount(outcome.saved) }),
    };
};

const lines = computed<Line[]>(() =>
    (table?.rows ?? []).map((row) => {
        const { outcome } = row;
        const settled = outcome.kind === `lower` || outcome.kind === `higher`;
        return {
            key: row.key,
            label: t(`sandbox.measurementPanel.metric.${row.key}`),
            on: average(row.on),
            off: average(row.off),
            result: settled
                ? change(row, outcome)
                : outcome.kind === `unclear`
                  ? t(`sandbox.measurementPanel.noClearDifference`)
                  : t(`sandbox.measurementPanel.tooEarly`),
            settled,
            // Only a measured drop earns green; a measured rise is a finding to act on, so it is not left grey either.
            mark: MARKS[outcome.kind],
            tip: tipOf(row, table?.unit ?? `turns`),
        };
    }),
);

const shortfall = computed<number>(() => (table === undefined ? 0 : shortfallOf(table)));
</script>

<template>
    <!-- No background or border of its own: the row's `#below` spine and the group's `divide-y` already provide the boundaries.
         Capped: on a wide pane an uncapped table strands its figures a hand's width from the names they belong to. -->
    <div class="flex max-w-xl flex-col gap-3">
        <!-- Fixed columns, not sized to content: the section stacks several of these tables, and columns that moved from
             one to the next would make the same "With" figure sit in a different place under each setting. -->
        <table v-if="table !== undefined" class="w-full table-fixed border-collapse text-xs tabular-nums">
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
                <tr v-for="line in lines" :key="line.key" class="border-t border-line-subtle">
                    <th scope="row" class="py-1.5 pr-2 text-left font-normal text-muted">{{ line.label }}</th>
                    <td class="py-1.5 pl-4 text-right" :class="line.settled ? `text-content` : `text-muted`">{{ line.on }}</td>
                    <td class="py-1.5 pl-4 text-right" :class="line.settled ? `text-content` : `text-muted`">{{ line.off }}</td>
                    <td class="whitespace-nowrap py-1.5 pl-6 text-left">
                        <!-- The statistics behind the words (the likely range, the sample still owed) are a hover away for
                             whoever asks, not printed for everyone; a dotted underline on an open row says so. -->
                        <span
                            v-tooltip.top="line.tip"
                            :tabindex="line.tip === undefined ? undefined : 0"
                            class="inline-block"
                            :class="[
                                line.mark,
                                line.tip === undefined ? `` : `cursor-help`,
                                line.tip !== undefined && !line.settled
                                    ? `underline decoration-line-strong decoration-dotted underline-offset-3`
                                    : ``,
                            ]"
                            >{{ line.result }}</span
                        >
                    </td>
                </tr>
            </tbody>
        </table>
        <p v-else class="text-xs text-subtle">{{ t(`sandbox.measurementPanel.noResultsYet`) }}</p>

        <!-- Said once for the whole table, not as "Too early" plus a reason on every row. -->
        <p v-if="table?.minimum !== undefined && shortfall > 0" class="text-2xs text-subtle">
            {{ t(`sandbox.measurementPanel.resultsAppearAt`, { minimum: table.minimum, shortfall }) }}
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
