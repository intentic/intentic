<script setup lang="ts">
import { computed } from "vue";

/* The trend line on a stat tile, a shape cue, not a readable plot: no axis, no labels, no hover. It draws in
 * `currentColor`, so the caller's text class sets the de-emphasis hue. `preserveAspectRatio="none"` lets it
 * stretch to whatever width the tile has; `vector-effect="non-scaling-stroke"` is what keeps that stretch from
 * smearing the stroke along with it. */

const { points } = defineProps<{ points: readonly number[] }>();

const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 20;
const INSET = 1; // room for the stroke's own width at the extremes, so a peak isn't shaved by the viewBox.

const path = computed(() => {
    const max = Math.max(...points, 0);
    const step = points.length > 1 ? VIEW_WIDTH / (points.length - 1) : 0;
    // A flat series (all zero) sits on the baseline rather than dividing by zero into NaN.
    const y = (value: number): number => (max === 0 ? VIEW_HEIGHT - INSET : VIEW_HEIGHT - INSET - (value / max) * (VIEW_HEIGHT - 2 * INSET));
    return points.map((value, index) => `${index === 0 ? `M` : `L`}${(index * step).toFixed(2)},${y(value).toFixed(2)}`).join(` `);
});
</script>

<template>
    <svg v-if="points.length > 1" :viewBox="`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`" preserveAspectRatio="none" class="h-5 w-full" aria-hidden="true">
        <path
            :d="path"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
        />
    </svg>
</template>
