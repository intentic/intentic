<script lang="ts">
import type { ExperimentVerdict } from "../../usage/savingsChart";

// Plain <script> block only to export these types; `<script setup>` can't carry an export.

/** One arm of the comparison: how many samples it holds, and its reading when the metric has a mean. */
export interface PanelArm {
    readonly turns: number;
    readonly mean?: number;
}

export interface PanelReading {
    readonly verdict: ExperimentVerdict;
    readonly on: PanelArm;
    readonly off: PanelArm;
    /** What the two means count ("listings/turn"); present exactly when they are. */
    readonly meanUnit?: string;
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import { Verdict, VERDICT_TONES } from "@intentic/ui";
import { commitPercent } from "./numberInputs";
import { useT } from "@intentic/ui/i18n";

// The measured half of a setting that runs a holdout (iq search teaching, the project map, the output cleaners), in
// one fixed order: what it found, the arms it found it over, the same experiment's other readings, then the holdout
// that split them. The knob is last and quietest because it configures the method, and a method drawn at a setting's
// weight reads as a second setting. Methodology itself belongs in the group's info card, not in this block.

const t = useT();

const {
    percent,
    readings,
    note,
    onLabel,
    offLabel,
    disabled = false,
} = defineProps<{
    /** Holdout percent (0-100). */
    percent: number;
    /** First entry is the headline; empty until the daemon has an experiment to report. */
    readings: readonly PanelReading[];
    /** Completes the sentence the percent box starts: "10% …of conversations open without it, as a control." */
    note: string;
    /** Arm labels in the reader's words, e.g. "taught" / "cold". */
    onLabel: string;
    offLabel: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{ commit: [fraction: number] }>();

const headline = computed<PanelReading | undefined>(() => readings[0]);

// Treated first: the row above is about the treatment, so the arm it names leads and the control is the thing
// compared against. Bars share one scale (the larger mean), since two scales would make equal arms look different.
const arms = computed(() => {
    const reading = headline.value;
    const on = reading?.on.mean;
    const off = reading?.off.mean;
    if (reading === undefined || reading.meanUnit === undefined || on === undefined || off === undefined) {
        return [];
    }
    const max = Math.max(on, off, Number.EPSILON);
    return [
        { key: `on`, label: onLabel, mean: on, turns: reading.on.turns, width: `${(on / max) * 100}%`, fill: `bg-primary-500` },
        { key: `off`, label: offLabel, mean: off, turns: reading.off.turns, width: `${(off / max) * 100}%`, fill: `bg-series-other` },
    ];
});

// The arms as one line, for an experiment that publishes no mean to draw (the cleaners compare shares of commands).
const sample = computed<string>(() => {
    const reading = headline.value;
    return reading === undefined ? `` : `${reading.on.turns.toLocaleString()} ${onLabel} · ${reading.off.turns.toLocaleString()} ${offLabel}`;
});
</script>

<template>
    <!-- No background or border of its own: the row's `#below` spine and the group's `divide-y` already provide the boundaries. -->
    <div class="flex flex-col gap-3">
        <div v-if="headline !== undefined" class="flex flex-col gap-2.5">
            <!-- The answer, at the block's only display size; no `evidence`, since the arms below carry the sample. -->
            <Verdict
                :value="headline.verdict.value"
                :unit="headline.verdict.unit"
                :tone="headline.verdict.tone"
                :detail="headline.verdict.detail"
            />

            <!-- The two arms' means, drawn, so the headline's "↓63.7%" is shown rather than asserted. The bar column is
                 capped and the grid starts at the left: a bar run to the pane's edge outweighs the verdict it serves,
                 and the comparison being made is between the two bars, not against the card. -->
            <div v-if="arms.length > 0" class="grid grid-cols-[auto_minmax(0,9rem)_auto] items-center justify-start gap-x-2.5 gap-y-1.5">
                <template v-for="arm in arms" :key="arm.key">
                    <span class="text-2xs text-muted">{{ arm.label }}</span>
                    <!-- Track is drawn, not implied: a thin arm must still look measured, not missing. -->
                    <span class="h-1.5 overflow-hidden rounded-full bg-canvas">
                        <span class="block h-full min-w-px rounded-full" :class="arm.fill" :style="{ width: arm.width }" />
                    </span>
                    <span class="text-2xs tabular-nums text-subtle">{{ arm.mean }} {{ headline.meanUnit }} · n={{ arm.turns }}</span>
                </template>
            </div>
            <p v-else class="text-2xs tabular-nums text-subtle">{{ sample }}</p>

            <!-- Other readings of the SAME experiment: named on the left, answered on the right, so a two-metric
                 experiment reads as one answer with a footnote instead of two competing headlines. -->
            <dl v-if="readings.length > 1" class="flex flex-col gap-1 border-t border-line-subtle pt-2">
                <div v-for="more in readings.slice(1)" :key="more.verdict.subject" class="flex items-baseline justify-between gap-3">
                    <dt class="min-w-0 text-2xs text-muted">{{ more.verdict.subject }}</dt>
                    <dd class="shrink-0 text-2xs font-medium tabular-nums" :class="VERDICT_TONES[more.verdict.tone]">{{ more.verdict.value }}</dd>
                </div>
            </dl>
        </div>
        <p v-else class="text-2xs text-subtle">{{ t(`sandbox.measurementPanel.nothingMeasuredYet`) }}</p>

        <!-- The holdout as the sentence it is: the box is the subject, `note` finishes it, so the number needs no label
             of its own. Unfilled, unlike a form's fields: a filled box is the loudest thing on a block of 11px type. -->
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line-subtle pt-3 text-2xs text-muted">
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
