<script setup lang="ts">
import { computed } from "vue";

// A ring cut into discrete arcs, for progress through a countable list rather than a continuous fraction: the reader
// counts ticks instead of estimating a percentage. Lit arcs are drawn in `currentColor`, so a Tailwind `text-*` class
// on the element sets them; the rest wear the same faint track ProgressRing uses, so a rim that swaps between the two
// components does not change weight. Rotated to start at 12 o'clock and fill clockwise, like ProgressRing.
const { segments, filled, size = 14, stroke = 2 } = defineProps<{ segments: number; filled: number; size?: number; stroke?: number }>();

// Below this many px a slot cannot hold both a tick and a gap, so the gaps close and a long list reads as a plain arc:
// the proportion stays true, only the counting is lost. Beats clamping the count, which would lie about the total.
const MIN_SLOT = 5;
const GAP = 2.5;

const radius = computed(() => (size - stroke) / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);
// At least one slot: a zero count would divide the circumference by nothing.
const count = computed(() => Math.max(1, Math.round(segments)));
const slot = computed(() => circumference.value / count.value);
const gap = computed(() => (slot.value >= MIN_SLOT ? GAP : 0));
const dash = computed(() => slot.value - gap.value);
const lit = computed(() => Math.min(count.value, Math.max(0, Math.round(filled))));
const track = computed(() => `${dash.value} ${gap.value}`);
// The lit slots spelled out one by one, then a zero-length dash whose gap swallows everything left. The pattern's
// total is exactly one circumference, so the browser lays it down once instead of repeating it over the unlit rim.
const arc = computed(() => {
    const slots = Array.from({ length: lit.value }, () => track.value);
    const rest = circumference.value - lit.value * slot.value;
    return (rest > 0 ? [...slots, `0 ${rest}`] : slots).join(" ");
});
</script>

<template>
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" class="-rotate-90 shrink-0" aria-hidden="true">
        <circle
            :cx="size / 2"
            :cy="size / 2"
            :r="radius"
            fill="none"
            :stroke-width="stroke"
            :stroke-dasharray="track"
            :style="{ stroke: 'color-mix(in srgb, var(--color-content) 12%, transparent)' }"
        />
        <circle v-if="lit > 0" :cx="size / 2" :cy="size / 2" :r="radius" fill="none" stroke="currentColor" :stroke-width="stroke" :stroke-dasharray="arc" />
    </svg>
</template>
