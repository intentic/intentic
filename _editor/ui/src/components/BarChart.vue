<!-- A ranked horizontal bar figure: one measure across a handful of named things (package sizes, churn, test
     counts, cost by model, cost by agent). Horizontal because the labels are package paths, component names,
     model ids and agent titles — long, and unreadable rotated under a column.

     Scaled against the LEADER, not an axis: a ranked list is read by comparing bars to each other, and there is
     no gridline here to round up to. Every bar is directly labelled with its value, so nothing is hidden behind
     a hover — which is also why this figure carries no value tooltip. The label's tooltip is for truncation
     only.

     ONE MEASURE PER FIGURE. Two measures of different scale are two figures; a second axis here would be the
     dual-axis mistake wearing a bar chart's clothes.

     It serves both an authored document figure and the Usage tab's cost rankings, which had been a separate
     component with the same body — the same `|| 1` guard, the same three-column grid, the same 10px bar with a
     rounded data end, and the same reasoning copied into its header comment. What actually differed was three
     things, and each is a prop here rather than a fork: what the value PRINTS as (`display`), which rows name a
     bucket rather than a thing (`muted`), and how much of the width the label column may take. -->

<script setup lang="ts">
import { computed } from "vue";
import type { BarItem } from "./barChart.js";
import { seriesColor } from "./seriesAccent.js";

const { items, title, labelWidth = 9 } = defineProps<{ items: readonly BarItem[]; title?: string; labelWidth?: number }>();

// `|| 1` so an all-zero set divides by one and draws nothing, rather than dividing by zero and drawing NaN.
const max = computed(() => Math.max(...items.map((item) => item.value), 0) || 1);

// The authored tip label, else the number thousands-separated — a bare 18400 in a document about code is read
// slower than 18,400, and the author only writes `display` when the raw number is not the point.
const tip = (item: BarItem): string => item.display ?? item.value.toLocaleString();
</script>

<template>
    <!-- The vertical margin belongs to a figure standing in PROSE. Inside a card the heading above it already
         owns that spacing, and a second margin there reads as a gap nobody asked for. -->
    <figure class="flex flex-col gap-2" :class="title !== undefined ? `my-4` : ``">
        <!-- The title names what is plotted, which is what lets a single-series figure skip a legend box. -->
        <figcaption v-if="title !== undefined" class="text-xs font-medium text-content">{{ title }}</figcaption>
        <ul class="flex flex-col gap-2.5">
            <li
                v-for="item in items"
                :key="item.key ?? item.label"
                class="grid items-center gap-3"
                :style="{ gridTemplateColumns: `minmax(0,${labelWidth}rem) 1fr auto` }"
            >
                <!-- Text wears text tokens, never the series colour: the bar beside it carries identity. -->
                <span
                    v-tooltip.top.overflow="item.label"
                    class="truncate text-xs"
                    :class="item.muted === true ? `italic text-muted` : `text-content`"
                    >{{ item.label }}</span
                >
                <div class="min-w-0">
                    <!-- 10px thick, 4px rounded data-end, square at the baseline it grows from. `min-w-px` keeps
                         a tiny-but-nonzero value visible as a hairline instead of rounding it away to nothing. -->
                    <div
                        class="h-2.5 min-w-px rounded-r-xs"
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
