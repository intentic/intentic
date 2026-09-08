<!--
    The orientation line atop an operations board: one measure split by state ("3 running · 1 stopped"), colour-coded via StatusVariant. Zero counts
    hide by default; `always` keeps a count on screen even at zero. `skeleton` draws the outline before data arrives.
-->
<script setup lang="ts">
import type { StatusVariant } from "../feedback/StatusBadge.vue";

export interface TallyItem {
    readonly label: string;
    readonly value: number;
    readonly variant: StatusVariant;
    /** Render at zero. For the count that IS the subject of the board. */
    readonly always?: boolean;
}

const DOT: Record<StatusVariant, string> = {
    success: `bg-success`,
    danger: `bg-danger`,
    warning: `bg-warning`,
    info: `bg-info`,
    neutral: `bg-subtle`,
    primary: `bg-primary-500`,
};

const TEXT: Record<StatusVariant, string> = {
    success: `text-success`,
    danger: `text-danger`,
    warning: `text-warning`,
    info: `text-info`,
    neutral: `text-subtle`,
    primary: `text-primary-500`,
};

// Uneven on purpose and walked in order: state names are words of different lengths ("running", "stopped",
// "unhealthy"), and three bars of one width read as a rendering artifact rather than as a tally.
const SKELETON_LABELS = [`w-14`, `w-12`, `w-16`];

const { items = [], skeleton = 0 } = defineProps<{
    items?: readonly TallyItem[];
    /** How many placeholder tallies to draw while the counts are still being fetched. */
    skeleton?: number;
}>();
</script>

<template>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <!-- h-5 is the line box of the count above (`text-sm`), so the board does not lift when the numbers
             arrive; the bars are decoration, and the caller owns the one `role="status"` for the region. -->
        <span v-for="index in skeleton" :key="index" class="flex h-5 items-center gap-1.5" aria-hidden="true">
            <span class="skeleton h-2 w-2 shrink-0 rounded-full"></span>
            <span class="skeleton h-3 w-4"></span>
            <span class="skeleton h-3" :class="SKELETON_LABELS[(index - 1) % SKELETON_LABELS.length]"></span>
        </span>
        <template v-for="item in items" :key="item.label">
            <span v-if="item.value > 0 || item.always === true" class="flex items-center gap-1.5">
                <span class="h-2 w-2 shrink-0 rounded-full" :class="DOT[item.variant]"></span>
                <span class="text-sm font-semibold" :class="TEXT[item.variant]">{{ item.value }}</span>
                <span class="text-xs text-muted">{{ item.label }}</span>
            </span>
        </template>
        <!-- Whatever else belongs on the orientation line: a pass-rate ring, a "last checked" stamp. Separated
             by the same gap, so it reads as another fact rather than as a control. -->
        <slot />
    </div>
</template>
