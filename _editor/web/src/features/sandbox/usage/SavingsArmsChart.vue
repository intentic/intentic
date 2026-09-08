<script setup lang="ts">
import type { TurnMetricReading } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { meanLabel } from "./savingsChart";
import { providerColor } from "./usageChart";

// One reading's two arms, as two bars, not a trend line, since the arms aren't sampled evenly and the subject is
// a population comparison, not a quantity over time. Each arm is two lines (name+mean, then bar+n) so neither label
// ever truncates. The verdict itself lives in the card's headline (verdictsOf, savingsChart.ts); this chart only
// carries its qualification.

const { reading, onLabel, offLabel, detail } = defineProps<{
    reading: TurnMetricReading;
    onLabel: string;
    offLabel: string;
    // Verdict's qualifier (margin, or shortfall), printed under its arms since the headline has no room for it.
    detail: string;
}>();

const max = computed(() => Math.max(reading.on.mean, reading.off.mean, Number.EPSILON));
// Control shown first, the baseline claimed against; treated keeps the brand hue, control stays achromatic.
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
                <!-- Track is drawn, not implied: a cheap arm must still look measured, not missing. -->
                <div class="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-canvas">
                    <div class="h-full min-w-px rounded-full" :style="{ width: `${(bar.arm.mean / max) * 100}%`, background: bar.color }" />
                </div>
                <span class="w-14 shrink-0 text-right text-2xs tabular-nums text-subtle">n={{ bar.arm.turns }}</span>
            </div>
        </div>

        <p class="text-2xs tabular-nums text-subtle">{{ detail }}</p>
    </figure>
</template>
