<script lang="ts">
import type { ExperimentVerdict } from "../savingsChart";

/* A plain <script> block purely so the shape a caller has to build is EXPORTED: `<script setup>` cannot carry
 * an export, and a type its two callers assemble by hand is exactly the thing that should be named once. */
export interface PanelReading {
    readonly verdict: ExperimentVerdict;
    /* The two arms' sample sizes. They travel with the verdict because this row has no chart to carry them
     * (the Usage tab's does), and a figure with no account of how much data is behind it is one a reader
     * cannot weigh. */
    readonly on: number;
    readonly off: number;
}
</script>

<script setup lang="ts">
import { ui } from "@intentic/ui";
import { commitPercent } from "./numberInputs";

/* THE "MEASURE IT" BLOCK (a setting's control group and what its experiment has said so far) written once
 * for the two settings that carry one (the terse steer, the iq search teaching).
 *
 * ONE COMPONENT BECAUSE THE SHAPE THEY HAD DRIFTED INTO WAS THE FAULT. Both rows glued four separate facts:
 * the verdict, its margin, how much sample is still owed, and the two arms' sizes: into a single sentence
 * joined by em dashes, set at one size, sitting under a sub-control of the same weight as the row's own
 * description. Four facts at one rank read as none, and the row that carried the most information on the page
 * was the one nobody could read. The Savings card had already solved this for the SAME readings: a verdict slot
 * the eye lands on first, then what qualifies it, then the evidence. This is that discipline at row scale.
 *
 * THE FIRST READING IS THE HEADLINE, and the rule lives here rather than at each call site: an experiment has
 * exactly one (savingsChart.ts, verdictsOf), and the others are second readings of the same subject. Rendering
 * them as peers is what turns one answer into two competing ones.
 *
 * THE METHODOLOGY IS NOT HERE. Why a control group is needed at all, and why an arm is pinned for a whole
 * conversation, are paragraphs: they belong in the group's (i), which is a dialog with room for them. A
 * settings row is read in a glance or not at all, so it gets one line: what the number does. */

const {
    percent,
    readings,
    note,
    onLabel,
    offLabel,
    disabled = false,
} = defineProps<{
    /** The holdout as the whole percent the box shows. */
    percent: number;
    /** Headline first: see above. Empty until the daemon has an experiment to report. */
    readings: readonly PanelReading[];
    /** ONE line saying what the box does. Anything longer belongs in the group's (i). */
    note: string;
    /** What each arm is called, in the reader's words: "steered" / "unsteered", "taught" / "cold". */
    onLabel: string;
    offLabel: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{ commit: [fraction: number] }>();

/* The same three tones the Savings card paints a verdict in, and for the same reason: success is reserved for
 * a saving that was actually measured, never for an experiment that is merely running. */
const VALUE_TONE = { success: `text-success`, content: `text-content`, muted: `text-muted` } as const;
</script>

<template>
    <!-- A RECESSED WELL, not another framed box. `bg-canvas` inside the row's `bg-card` reads as a step DOWN
         from the setting it belongs to, which is the relationship: a stroke here would read as a second row. -->
    <div class="rounded-lg bg-canvas px-3 py-2.5">
        <label class="flex items-center justify-between gap-3">
            <span class="flex min-w-0 flex-col">
                <span class="text-xs font-medium text-content">Measure it</span>
                <span class="text-2xs text-muted">{{ note }}</span>
            </span>
            <span class="flex shrink-0 items-center gap-1">
                <input
                    type="number"
                    min="0"
                    max="100"
                    :value="percent"
                    :disabled="disabled"
                    :class="ui.input('w-16 text-right text-xs')"
                    @change="(event: Event) => commitPercent(event, percent, (fraction: number) => emit(`commit`, fraction))"
                />
                <span class="text-xs text-muted">%</span>
            </span>
        </label>

        <!-- WHAT IT HAS SAID SO FAR. Three ranks, one fact each: the answer, what qualifies it, what it was
             measured over. Nothing on this side of the rule is a control, so nothing on it is at control
             weight. -->
        <div v-if="readings[0] !== undefined" class="mt-2.5 border-t border-line-subtle pt-2.5">
            <p class="flex flex-wrap items-baseline gap-x-1.5">
                <span class="text-sm font-semibold tabular-nums" :class="VALUE_TONE[readings[0].verdict.tone]">{{ readings[0].verdict.value }}</span>
                <span class="min-w-0 text-2xs text-muted">{{ readings[0].verdict.unit }}</span>
            </p>
            <p v-if="readings[0].verdict.detail !== ``" class="mt-1 text-2xs text-subtle">{{ readings[0].verdict.detail }}</p>
            <p class="mt-0.5 text-2xs tabular-nums text-subtle">
                {{ readings[0].on.toLocaleString() }} {{ onLabel }} · {{ readings[0].off.toLocaleString() }} {{ offLabel }}
            </p>

            <!-- Second readings of the same experiment: one line, one rank below the headline, so a
                 two-metric experiment reads as one answer with a footnote rather than as two answers. -->
            <p v-for="more in readings.slice(1)" :key="more.verdict.unit" class="mt-2 flex flex-wrap items-baseline gap-x-1.5">
                <span class="text-xs font-medium tabular-nums" :class="VALUE_TONE[more.verdict.tone]">{{ more.verdict.value }}</span>
                <span class="min-w-0 text-2xs text-muted">{{ more.verdict.unit }}</span>
            </p>
        </div>
    </div>
</template>
