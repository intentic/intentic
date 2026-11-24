<script setup lang="ts">
import { computed } from "vue";
import { memoryTone } from "./memoryFiles";

// How much of a turn's room for memory one file takes, as a pie in a rim: a wedge reads as an amount at a glance, where
// a thin arc this small read as a spinner still loading. A file too small to see gets a sliver, so an empty rim always
// means an empty file. Its ink says the rest (memoryTone): accent, warning near the ceiling, danger once it is left out.

const { share, dropped, size = 16 } = defineProps<{ share: number; dropped: boolean; size?: number }>();

const RIM = 1.5;
const GAP = 1.25;
const SLIVER = 10;

const centre = computed(() => size / 2);
const radius = computed(() => size / 2 - RIM - GAP);
const shown = computed(() => (share <= 0 ? 0 : Math.min(100, Math.max(share, SLIVER))));
// The wedge from twelve o'clock, clockwise; a whole disc once it is full, since an arc cannot close on itself.
const wedge = computed(() => {
    const angle = (shown.value / 100) * 2 * Math.PI;
    const c = centre.value;
    const r = radius.value;
    const x = c + r * Math.sin(angle);
    const y = c - r * Math.cos(angle);
    return `M ${c} ${c} L ${c} ${c - r} A ${r} ${r} 0 ${angle > Math.PI ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
});
</script>

<template>
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" class="shrink-0" :class="memoryTone({ share, dropped })" aria-hidden="true">
        <circle :cx="centre" :cy="centre" :r="size / 2 - RIM / 2" fill="none" stroke="currentColor" :stroke-width="RIM" stroke-opacity="0.45" />
        <circle v-if="shown >= 100" :cx="centre" :cy="centre" :r="radius" fill="currentColor" />
        <path v-else-if="shown > 0" :d="wedge" fill="currentColor" />
    </svg>
</template>
