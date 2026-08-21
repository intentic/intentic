<!-- THE OUTLINE OF AN INDEX-AND-BODY SCREEN whose code has not arrived yet: what asyncView draws for a
     <SplitView>-shaped route (the hubs, Capabilities) while its chunk is in flight. The title and description
     are the page's own words, passed in at registration: they are static strings the route already knows, so
     the reader gets the real heading in the first frame and only the rows arrive as skeletons.

     IT RENDERS THE REAL SHELL. The frame is <SplitView> itself and the rows are <SkeletonRows>, for the same
     reason SkeletonRows renders real <Row>s: an outline that merely resembles the page drifts from it the
     first time a width or a density changes, and the page then jumps as it lands. Folded, the rail's stand-in
     is a strip of pill skeletons: the shape of the segmented control every folded hub shows.

     The reveal-delay/minimum-hold gating lives in asyncView, not here: this component draws the outline
     whenever it is mounted, and whether the wait deserves to be SEEN is its caller's one decision. -->
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
            <div class="flex gap-2 overflow-hidden border-b border-line pb-2" aria-hidden="true">
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
