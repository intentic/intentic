<script setup lang="ts">
import type { TurnMetricReading } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { meanLabel } from "./savingsChart";
import { providerColor } from "./usageChart";

/* ONE READING's two arms. Every turn-level reading this page charts renders through here, because readings
 * differ in nothing a reader cares about except which arm is which and what the bars measure.
 *
 * Two bars rather than a trend line, because the subject is a comparison of two populations, not a quantity
 * over time, and the arms are not sampled evenly through the window (the holdout is a minority by design), so
 * a line would draw a shape that is an artefact of the coin flip.
 *
 * Each arm is TWO lines (its name and mean on one, its bar and n on the next) rather than one line of
 * [label | bar | value] in fixed columns. The columned version reserved 7.5rem for a label and truncated it,
 * so on a card this section actually renders at, the two things a reader must tell apart read "steer off …"
 * and "steer on". Nothing here is allowed to truncate: a bar whose arm you cannot name is not evidence.
 *
 * The verdict is NOT here. It is the card's headline (verdictsOf in savingsChart.ts), where a reader looks
 * first; this chart carries only what qualifies it. */

const { reading, onLabel, offLabel, detail } = defineProps<{
    reading: TurnMetricReading;
    onLabel: string;
    offLabel: string;
    // The verdict's own qualification (its margin, or how far the shorter arm has left to run) printed under
    // the arms it is about rather than beside the headline, which has no room for a clause.
    detail: string;
}>();

const max = computed(() => Math.max(reading.on.mean, reading.off.mean, Number.EPSILON));
// Control first: it is the baseline the other bar is a claim against, and reading it second inverts the
// sentence. The treated arm keeps the brand hue; the control stays achromatic, so which is which survives a
// greyscale print as well as the labels do.
const bars = computed(() => [
    { key: `off`, label: offLabel, arm: reading.off, color: `var(--color-series-other)` },
    { key: `on`, label: onLabel, arm: reading.on, color: providerColor(`claude`) },
]);
</script>

<template>
    <figure class="flex min-w-0 flex-col gap-2.5">
        <div v-for="bar in bars" :key="bar.key" class="flex min-w-0 flex-col gap-1">
            <div class="flex min-w-0 items-baseline justify-between gap-2">
                <span class="min-w-0 text-xs text-content">{{ bar.label }}</span>
                <span class="shrink-0 text-2xs tabular-nums text-muted">{{ meanLabel(reading, bar.arm.mean) }}</span>
            </div>
            <div class="flex items-center gap-2">
                <!-- The track is drawn, not implied: an arm that ran cheap still has to look like a measured
                     quantity rather than a missing one. -->
                <div class="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-canvas">
                    <div class="h-full min-w-px rounded-full" :style="{ width: `${(bar.arm.mean / max) * 100}%`, background: bar.color }" />
                </div>
                <span class="w-14 shrink-0 text-right text-2xs tabular-nums text-subtle">n={{ bar.arm.turns }}</span>
            </div>
        </div>

        <p class="text-2xs tabular-nums text-subtle">{{ detail }}</p>
    </figure>
</template>
