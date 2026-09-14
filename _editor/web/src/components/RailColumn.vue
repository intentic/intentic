<!-- Column frame for a list of agents (wraps RailLane and RailCard), used by the chat rail and Subagents. -->
<script setup lang="ts">
import { computed } from "vue";
import { ResizeSeam } from "@intentic/ui";
import { DEFAULT_RAIL_WIDTH, MAX_RAIL_WIDTH, MIN_RAIL_WIDTH, railWidth, setRailWidth } from "../features/agents/board/columnWidth";
import { toAppPx, toScreenPx, uiLength } from "../shell/window/uiScale";

/* The seam speaks in pointer coordinates; the rail's width is stored in app pixels (see uiScale). */
const seamWidth = computed<number>({
    get: () => toScreenPx(railWidth.value),
    set: (px) => setRailWidth(toAppPx(px)),
});
</script>

<template>
    <!-- Lane slabs provide the column structure, so no extra right divider is needed. -->
<!-- The width stays on the <aside>, which is the rail: hosts, and railColumn.test.ts, address it as one element at one width. -->
    <aside class="relative flex h-full min-h-0 shrink-0" :style="{ width: uiLength(railWidth) }">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col items-stretch gap-1 p-1.5">
            <slot />
        </div>
        <ResizeSeam
            v-model="seamWidth"
            :min="toScreenPx(MIN_RAIL_WIDTH)"
            :max="toScreenPx(MAX_RAIL_WIDTH)"
            :reset="toScreenPx(DEFAULT_RAIL_WIDTH)"
            title="Drag to resize · double-click to reset"
        />
    </aside>
</template>
