<script setup lang="ts">
import { computed } from "vue";
import { formatUsd, type RankedEntry, rankedColor, rankedKey } from "./usageChart";

/* Cost by <dimension>, ranked. Horizontal because the labels are model ids and agent titles — long, and
 * unreadable rotated under a column.
 *
 * The bar wears its PROVIDER's colour, never a ramp keyed to its own length: a darker-because-bigger bar
 * double-encodes what the length already says and burns the one free channel. Every bar is directly labelled
 * with its value, which is also how the palette's sub-3:1 slots earn their keep. */

const { entries } = defineProps<{ entries: readonly RankedEntry[] }>();

// Scaled against the leader, not an axis: a ranked list is read by comparing bars to each other, and there is
// no gridline here to round up to.
const max = computed(() => Math.max(...entries.map((entry) => entry.value), 0) || 1);
</script>

<template>
    <ul class="flex flex-col gap-2.5">
        <li v-for="entry in entries" :key="rankedKey(entry)" class="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3">
            <!-- Text wears text tokens, never the series colour: the swatch beside it carries identity. -->
            <span v-tooltip.top="entry.label" class="truncate text-xs" :class="entry.kind === `value` ? `text-content` : `text-muted italic`">{{
                entry.label
            }}</span>
            <div class="min-w-0">
                <div class="h-2.5 min-w-px rounded-r-[4px]" :style="{ width: `${(entry.value / max) * 100}%`, background: rankedColor(entry) }" />
            </div>
            <span class="justify-self-end text-2xs tabular-nums text-muted">{{ formatUsd(entry.value) }}</span>
        </li>
    </ul>
</template>
