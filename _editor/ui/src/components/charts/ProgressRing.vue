<script setup lang="ts">
import { computed } from "vue";

// A tiny circular progress meter. The arc is drawn with `currentColor`, so a Tailwind `text-*` class on the
// element sets its colour (e.g. text-primary-500, or text-warning past a threshold); the track is a faint
// neutral. Rotated so the arc starts at 12 o'clock and fills clockwise.
const { value, size = 14, stroke = 2 } = defineProps<{ value: number; size?: number; stroke?: number }>();

const radius = computed(() => (size - stroke) / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);
// Clamp 0-100 so a stray out-of-range value can't invert the arc.
const offset = computed(() => circumference.value * (1 - Math.min(100, Math.max(0, value)) / 100));
</script>

<template>
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" class="-rotate-90 shrink-0" aria-hidden="true">
        <circle
            :cx="size / 2"
            :cy="size / 2"
            :r="radius"
            fill="none"
            :stroke-width="stroke"
            :style="{ stroke: 'color-mix(in srgb, var(--color-content) 12%, transparent)' }"
        />
        <circle
            :cx="size / 2"
            :cy="size / 2"
            :r="radius"
            fill="none"
            stroke="currentColor"
            :stroke-width="stroke"
            stroke-linecap="round"
            :stroke-dasharray="circumference"
            :stroke-dashoffset="offset"
        />
    </svg>
</template>
