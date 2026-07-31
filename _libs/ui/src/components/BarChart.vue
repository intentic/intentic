<!-- A ranked horizontal bar figure: one measure across a handful of named things (package sizes, churn, test
     counts). Horizontal because the labels are package paths and component names — long, and unreadable
     rotated under a column.

     Scaled against the LEADER, not an axis: a ranked list is read by comparing bars to each other, and there is
     no gridline here to round up to. Every bar is directly labelled with its value, so nothing is hidden behind
     a hover — which is also why this figure carries no value tooltip. The label's tooltip is for truncation
     only.

     ONE MEASURE PER FIGURE. Two measures of different scale are two figures; a second axis here would be the
     dual-axis mistake wearing a bar chart's clothes. -->
<script setup lang="ts">
import { computed } from "vue";
import type { BarsFigureItem } from "../markdown/figures.js";
import { seriesColor } from "./seriesAccent.js";

const { items, title } = defineProps<{ items: readonly BarsFigureItem[]; title?: string }>();

// `|| 1` so an all-zero set divides by one and draws nothing, rather than dividing by zero and drawing NaN.
const max = computed(() => Math.max(...items.map((item) => item.value), 0) || 1);

// The authored tip label, else the number thousands-separated — a bare 18400 in a document about code is read
// slower than 18,400, and the author only writes `display` when the raw number is not the point.
const tip = (item: BarsFigureItem): string => item.display ?? item.value.toLocaleString();
</script>

<template>
    <figure class="my-4 flex flex-col gap-2">
        <!-- The title names what is plotted, which is what lets a single-series figure skip a legend box. -->
        <figcaption v-if="title !== undefined" class="text-xs font-medium text-content">{{ title }}</figcaption>
        <ul class="flex flex-col gap-2.5">
            <li v-for="item in items" :key="item.label" class="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3">
                <!-- Text wears text tokens, never the series colour: the bar beside it carries identity. -->
                <span v-tooltip.top.overflow="item.label" class="truncate text-xs text-content">{{ item.label }}</span>
                <div class="min-w-0">
                    <!-- 10px thick, 4px rounded data-end, square at the baseline it grows from. `min-w-px` keeps
                         a tiny-but-nonzero value visible as a hairline instead of rounding it away to nothing. -->
                    <div
                        class="h-2.5 min-w-px rounded-r-[4px]"
                        :style="{ width: `${(item.value / max) * 100}%`, background: seriesColor(item.accent) }"
                    />
                </div>
                <!-- tabular-nums here and NOT on a stat tile's value: this is a column of numbers that must
                     align vertically, which is the one case the figures should be monospaced. -->
                <span class="justify-self-end text-2xs tabular-nums text-muted">{{ tip(item) }}</span>
            </li>
        </ul>
    </figure>
</template>
