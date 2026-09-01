<script setup lang="ts">
import { RowGroup, StatusTally } from "@intentic/extension-ui";

/* What the Pipelines view shows before its first /ci/runs response: the SHAPE of the answer, not a spinner.
 * The geometry here is a deliberate copy of the real thing: summary bar, repo group, run rows with a status
 * dot, an avatar, a headline, a meta line, stage circles and an action button, so the page does not jump when
 * the data lands, and so the wait already tells the reader what they are waiting for.
 *
 * The two shapes the board draws with kit components are drawn here with the SAME ones, in their loading form:
 * <StatusTally skeleton> for the summary line and <RowGroup> for the group, rather than a second copy of their
 * markup that a change to either would leave behind.
 *
 * Widths vary per row because a column of identical bars reads as a rendering artifact rather than as a list
 * of commit subjects. They are fixed, not random: a placeholder that reshuffles on every re-render is worse
 * than one that repeats. */

// Headline/meta widths per row, and how many stage circles that row hints at: a real board has neither a
// uniform subject length nor a uniform pipeline shape.
const ROWS = [
    { headline: `w-72`, author: `w-20`, stages: 3 },
    { headline: `w-56`, author: `w-16`, stages: 4 },
    { headline: `w-80`, author: `w-24`, stages: 3 },
    { headline: `w-64`, author: `w-16`, stages: 2 },
    { headline: `w-48`, author: `w-20`, stages: 4 },
    { headline: `w-72`, author: `w-16`, stages: 3 },
] as const;
</script>

<template>
    <!-- aria-busy over aria-hidden: a screen reader should hear "this region is loading", not silence that is
         indistinguishable from an empty board. The bars themselves carry no text, so there is nothing to read. -->
    <div role="status" aria-busy="true" aria-label="Loading pipelines">
        <!-- Summary bar: the three status counters and the pass-rate ring, which rides the tally's own slot
             exactly as the real one does. -->
        <StatusTally :skeleton="3" class="mb-5">
            <div class="flex h-5 items-center gap-2">
                <span class="skeleton h-5 w-5 rounded-full"></span>
                <span class="skeleton h-3 w-20"></span>
            </div>
        </StatusTally>

        <!-- One repo group. A second would be a guess about the workspace; one is the floor every board has.
             h-4 in the heading slots is the line box of the label they stand in for (`text-xs`). -->
        <RowGroup>
            <template #label>
                <span class="flex h-4 items-center gap-2">
                    <span class="skeleton h-3 w-24"></span>
                    <span class="skeleton h-3 w-3 rounded-full"></span>
                    <span class="skeleton h-3 w-32"></span>
                </span>
            </template>

            <!-- Wraps exactly as the real row does (PipelineRunRow), so a narrow pane does not re-flow the
                 list the moment the runs land. -->
            <div
                v-for="(row, index) in ROWS"
                :key="index"
                class="flex w-full flex-wrap items-center gap-x-3 gap-y-2 border-l-4 border-line px-4 py-3"
            >
                <span class="skeleton h-4 w-4 shrink-0 rounded-full"></span>
                <span class="skeleton h-6 w-6 shrink-0 rounded-full"></span>

                <!-- The two line boxes are h-5 / h-4 with an h-0.5 gap because that is exactly what the real
                     headline (text-sm) and meta line (text-2xs, mt-0.5) measure: a 63px row either way, so
                     the list does not shuffle upward the moment the runs arrive. -->
                <div class="min-w-40 flex-1">
                    <div class="flex h-5 items-center gap-2">
                        <span class="skeleton h-3.5 max-w-full" :class="row.headline"></span>
                        <span class="skeleton h-4 w-14 rounded-md"></span>
                    </div>
                    <div class="mt-0.5 flex h-4 items-center gap-2">
                        <span class="skeleton h-2.5" :class="row.author"></span>
                        <span class="skeleton h-2.5 w-10"></span>
                        <span class="skeleton h-2.5 w-12"></span>
                    </div>
                </div>

                <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
                    <!-- Stage circles, connectors and all: the row's most distinctive shape, and the part a
                         reader scans first once the data is there. -->
                    <div class="scrollbar-thin flex max-w-max min-w-24 flex-1 basis-0 items-center overflow-x-auto">
                        <template v-for="stage in row.stages" :key="stage">
                            <span v-if="stage > 1" class="h-px w-3 shrink-0 bg-line"></span>
                            <span class="skeleton h-6 w-6 shrink-0 rounded-full"></span>
                        </template>
                    </div>

                    <div class="flex shrink-0 items-center gap-2">
                        <span class="skeleton h-2.5 w-12"></span>
                        <span class="skeleton h-6 w-24 rounded-md"></span>
                        <span class="skeleton mx-1 h-3 w-3"></span>
                    </div>
                </div>
            </div>
        </RowGroup>
    </div>
</template>
