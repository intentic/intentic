<script setup lang="ts">
import type { OutputSavings } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { formatCompact, seriesColor } from "./usageChart";

/* The terse steer's effect, as the experiment it is: two bars, each carrying its own n, and a delta only when
 * both arms are big enough to support one.
 *
 * Two bars rather than a trend line, because the subject is a comparison of two populations, not a quantity
 * over time — and the arms are not sampled evenly through the window (the holdout is a minority by design), so
 * a line would draw a shape that is an artefact of the coin flip.
 *
 * The ± is not decoration. Output tokens per turn are wildly spread — one turn is "yes", the next is a
 * forty-tool refactor — so a delta without its margin is a number that will read differently tomorrow. */

const { output } = defineProps<{ output: OutputSavings }>();

const max = computed(() => Math.max(output.on.meanOutputTokens, output.off.meanOutputTokens, 1));
const bars = computed(() => [
    { key: `off`, label: `steer off (control)`, arm: output.off, color: `var(--color-series-other)` },
    { key: `on`, label: `steer on`, arm: output.on, color: seriesColor(`claude`) },
]);

// Present together or not at all (the daemon withholds all three below the threshold), so one check gates the
// whole verdict line.
const measured = computed(() => output.deltaPct !== undefined && output.marginPct !== undefined);
const shortfall = computed(() => Math.max(output.minTurns - output.on.turns, output.minTurns - output.off.turns));
</script>

<template>
    <figure class="flex flex-col gap-2.5">
        <div v-for="bar in bars" :key="bar.key" class="grid grid-cols-[minmax(0,7.5rem)_1fr_auto] items-center gap-3">
            <span class="truncate text-xs text-content">{{ bar.label }}</span>
            <div class="min-w-0">
                <div class="h-2.5 min-w-px rounded-r-[4px]" :style="{ width: `${(bar.arm.meanOutputTokens / max) * 100}%`, background: bar.color }" />
            </div>
            <span class="justify-self-end text-2xs tabular-nums text-muted">
                {{ formatCompact(bar.arm.meanOutputTokens) }} tok/turn
                <span class="text-subtle">· n={{ bar.arm.turns }}</span>
            </span>
        </div>

        <!-- The verdict, or an honest account of why there isn't one yet. Direction is spelled with an arrow
             AND a sign, so it never rests on colour. -->
        <p v-if="measured" class="text-2xs tabular-nums" :class="(output.deltaPct ?? 0) < 0 ? `text-success` : `text-muted`">
            {{ (output.deltaPct ?? 0) < 0 ? `↓` : `↑` }}{{ Math.abs(output.deltaPct ?? 0) }}% output tokens per turn
            <span class="text-subtle">± {{ output.marginPct }}pp (95%)</span>
            <span v-if="(output.savedTokens ?? 0) > 0" class="text-subtle"
                >· ~{{ formatCompact(output.savedTokens ?? 0) }} tokens saved in this range</span
            >
        </p>
        <p v-else class="text-2xs text-subtle">
            Measuring — a turn's length varies too much for {{ output.on.turns }} steered and {{ output.off.turns }} unsteered turns to separate the
            steer from the work. {{ shortfall }} more {{ shortfall === 1 ? `turn` : `turns` }} on the shorter arm and this reports a figure.
        </p>
    </figure>
</template>
