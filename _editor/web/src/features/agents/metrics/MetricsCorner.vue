<!-- THE BOARD'S BOTTOM-LEFT CORNER, the geek metrics (BoardMetrics.vue `corner`), drawn at the end of the lane that ends
     the board's first column (AgentsView, boardGrid.ts `foot`). That lane stretches to its column's foot, and every lane
     keeps its full height there, so the column reaches the board's longest and the card, stuck to the board's foot, stays
     in sight however far it scrolls. The mark is where the column's cards end, read against the first screen's foot to
     open or fold the card (metricsCorner.ts). Spanning the board (the ledger), it keeps to that lane's first card column. -->
<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import BoardMetrics from "./BoardMetrics.vue";

defineProps<{
    metrics: SandboxMetrics;
    fold: boolean;
    // The lane spans the board, its cards in two columns.
    half: boolean;
}>();
</script>

<template>
    <div data-metrics-mark aria-hidden="true" />
    <div class="mt-auto h-6 shrink-0" aria-hidden="true" />
    <div data-metrics-corner data-reveal-column class="sticky bottom-3.5 z-10 sm:bottom-4 lg:bottom-6" :class="half ? `w-[calc(50%-0.5625rem)]` : ``">
        <BoardMetrics place="corner" :fold="fold" :metrics="metrics" />
    </div>
</template>
