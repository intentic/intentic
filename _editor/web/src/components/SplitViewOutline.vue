<!--
    Loading outline for a <SplitView>-shaped route (asyncView) while its chunk loads; title and description are passed in at registration. Renders
    the real <SplitView> and <SkeletonRows>, not an approximation. Reveal-delay and minimum-hold timing live in asyncView, not here.
-->
<script setup lang="ts">
import { SkeletonRows, SplitView } from "@intentic/ui";

const { railRows = 8, bodyRows = 4 } = defineProps<{
    /** The page's real heading: a static string the route table already knows, never a guess. */
    title: string;
    description?: string;
    /** How many index rows to promise. Match the shortest index the page actually shows. */
    railRows?: number;
    bodyRows?: number;
}>();

// Walked in order, so the folded strip's pills are uneven the way real section names are.
const PILL_WIDTHS = [`w-20`, `w-16`, `w-24`, `w-14`, `w-20`];
</script>

<template>
    <SplitView :title="title" :description="description" scroll="page">
        <template #compact>
            <div class="flex gap-2 overflow-hidden border-b border-line-subtle pb-2" aria-hidden="true">
                <span v-for="(width, index) in PILL_WIDTHS" :key="index" class="skeleton block h-6 shrink-0 rounded-full" :class="width" />
            </div>
        </template>
        <template #rail>
            <div aria-hidden="true">
                <SkeletonRows :rows="railRows" density="dense" />
            </div>
        </template>
        <template #detail>
            <!-- The one status region for the whole wait: the bars themselves are decoration (SkeletonRows
                 marks its rows aria-hidden), so the outline announces once rather than per skeleton. -->
            <div role="status" aria-busy="true" aria-label="Loading">
                <SkeletonRows :rows="bodyRows" description />
            </div>
        </template>
    </SplitView>
</template>
