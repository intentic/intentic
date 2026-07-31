<script setup lang="ts">
import type { TurnExperiment } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { formatCompact, seriesColor } from "./usageChart";

/* A turn-level experiment's effect, as the experiment it is: two bars, each carrying its own n, and a delta
 * only when both arms are big enough to support one. Both of this sandbox's turn experiments render through
 * here — the terse steer and the pre-injected workspace context — because they differ in nothing a reader
 * cares about except which arm is which and what the bars measure.
 *
 * Two bars rather than a trend line, because the subject is a comparison of two populations, not a quantity
 * over time — and the arms are not sampled evenly through the window (the holdout is a minority by design), so
 * a line would draw a shape that is an artefact of the coin flip.
 *
 * The ± is not decoration. Per-turn cost and output length are wildly spread — one turn is "yes", the next is a
 * forty-tool refactor — so a delta without its margin is a number that will read differently tomorrow. */

const { experiment, onLabel, offLabel } = defineProps<{ experiment: TurnExperiment; onLabel: string; offLabel: string }>();

// Dollars are printed to the thousandth because a turn costs cents; tokens compact, because a turn costs
// thousands. Same reason the daemon rounds them differently (turn-experiments.ts).
const money = computed(() => experiment.metric === `costUsd`);
const formatMean = (value: number): string => (money.value ? `$${value.toFixed(3)}` : `${formatCompact(value)} tok`);
const metricName = computed(() => (money.value ? `cost` : `output tokens`));

const max = computed(() => Math.max(experiment.on.mean, experiment.off.mean, Number.EPSILON));
const bars = computed(() => [
    { key: `off`, label: offLabel, arm: experiment.off, color: `var(--color-series-other)` },
    { key: `on`, label: onLabel, arm: experiment.on, color: seriesColor(`claude`) },
]);

// Present together or not at all (the daemon withholds all three below the threshold), so one check gates the
// whole verdict line.
const measured = computed(() => experiment.deltaPct !== undefined && experiment.marginPct !== undefined);
const shortfall = computed(() => Math.max(experiment.minTurns - experiment.on.turns, experiment.minTurns - experiment.off.turns));
const saved = computed(() => (money.value ? `$${(experiment.saved ?? 0).toFixed(2)}` : `${formatCompact(experiment.saved ?? 0)} tokens`));
</script>

<template>
    <figure class="flex flex-col gap-2.5">
        <div v-for="bar in bars" :key="bar.key" class="grid grid-cols-[minmax(0,7.5rem)_1fr_auto] items-center gap-3">
            <span class="truncate text-xs text-content">{{ bar.label }}</span>
            <div class="min-w-0">
                <div class="h-2.5 min-w-px rounded-r-[4px]" :style="{ width: `${(bar.arm.mean / max) * 100}%`, background: bar.color }" />
            </div>
            <span class="justify-self-end text-2xs tabular-nums text-muted">
                {{ formatMean(bar.arm.mean) }}/turn
                <span class="text-subtle">· n={{ bar.arm.turns }}</span>
            </span>
        </div>

        <!-- The verdict, or an honest account of why there isn't one yet. Direction is spelled with an arrow
             AND a sign, so it never rests on colour. -->
        <p v-if="measured" class="text-2xs tabular-nums" :class="(experiment.deltaPct ?? 0) < 0 ? `text-success` : `text-muted`">
            {{ (experiment.deltaPct ?? 0) < 0 ? `↓` : `↑` }}{{ Math.abs(experiment.deltaPct ?? 0) }}% {{ metricName }} per turn
            <span class="text-subtle">± {{ experiment.marginPct }}pp (95%)</span>
            <span v-if="(experiment.saved ?? 0) > 0" class="text-subtle">· ~{{ saved }} saved in this range</span>
        </p>
        <p v-else class="text-2xs text-subtle">
            Measuring — a turn varies too much for {{ experiment.on.turns }} treated and {{ experiment.off.turns }} control turns to separate the
            mechanism from the work. {{ shortfall }} more {{ shortfall === 1 ? `turn` : `turns` }} on the shorter arm and this reports a figure.
        </p>
    </figure>
</template>
