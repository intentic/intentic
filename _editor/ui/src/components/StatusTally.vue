<!-- The orientation line at the top of an operations board: "3 running · 1 stopped · 2 need attention".
     Answers "is anything wrong right now" before the reader parses a single row.

     NOT <StatStrip>, which is the document strip: big proportional numbers for unrelated measures a reader
     studies. These are a SINGLE measure split by state, read at a glance during an incident, so they are small,
     inline, and colour-coded by the same StatusVariant vocabulary <StatusBadge> uses. One tally vocabulary
     across the app: Pipelines and Deployments had each written this out by hand, byte-identical down to the
     `h-2 w-2 rounded-full`, which is how two boards end up disagreeing about what "failed" looks like.

     UNBOXED on purpose. It sits directly under a <PageHeader>, where the heading above and the first section
     label below already bound it: a border here is one more box in a view that is mostly boxes, and it
     frames a line that is not a container of anything.

     ZERO IS SILENT by default: "0 unhealthy" is a fact nobody asked for, and dropping it is what lets the eye
     land on the counts that are non-zero. `always` keeps the one count that is the board's subject (running,
     passed) on screen even at zero, because a tally that renders as nothing at all reads as a broken view.

     `skeleton` DRAWS THE LINE BEFORE THE COUNTS EXIST, for the same reason <RowGroup> takes a `#label` bar: a
     board's loading outline was re-typing this markup, so the copy the comment above is about survived in the
     skeletons after the boards themselves stopped keeping it. Drawn here, the outline cannot state a geometry
     the tally does not have. -->
<script setup lang="ts">
import type { StatusVariant } from "./StatusBadge.vue";

export interface TallyItem {
    readonly label: string;
    readonly value: number;
    readonly variant: StatusVariant;
    /** Render at zero. For the count that IS the subject of the board. */
    readonly always?: boolean;
    /** For a state that is in motion (running builds, deploying containers). */
    readonly pulse?: boolean;
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
                <span class="h-2 w-2 shrink-0 rounded-full" :class="[DOT[item.variant], item.pulse === true ? `animate-pulse` : ``]"></span>
                <span class="text-sm font-semibold" :class="TEXT[item.variant]">{{ item.value }}</span>
                <span class="text-xs text-muted">{{ item.label }}</span>
            </span>
        </template>
        <!-- Whatever else belongs on the orientation line: a pass-rate ring, a "last checked" stamp. Separated
             by the same gap, so it reads as another fact rather than as a control. -->
        <slot />
    </div>
</template>
