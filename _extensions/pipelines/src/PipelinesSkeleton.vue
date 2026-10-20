<script setup lang="ts">
import { Row, RowGroup } from "@intentic/extension-ui";
import { t } from "./i18n.js";

// Mirrors the real page's shape (repo group, rows with status dot, avatar, headline, meta, stage circles, action
// button) so the page doesn't jump when data lands. The orientation line's own skeleton (<PipelinesTally skeleton>) is
// drawn wherever the real one sits. Widths vary per row but are fixed, not random. The board's <Await> fallback: once the
// board has been seen, its imprint (`pipelines.board`) is drawn instead and this only covers the first visit.

// Per-row widths and stage count vary; a real board has neither uniform subjects nor uniform pipelines.
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
    <!-- aria-busy, not aria-hidden: silence here reads as an empty board, not as loading. -->
    <div role="status" aria-busy="true" :aria-label="t(`pipelinesSkeleton.loadingPipelines`)">
        <!-- One repo group: a second would be guessing about the workspace. h-4 matches the real label's text-xs line box. -->
        <RowGroup>
            <template #label>
                <span class="flex h-4 items-center gap-2">
                    <span class="skeleton h-3 w-24"></span>
                    <span class="skeleton h-3 w-3 rounded-full"></span>
                    <span class="skeleton h-3 w-32"></span>
                </span>
            </template>

            <!-- Real <Row>s, so padding, gaps and wrapping are the tier's, exactly as PipelineRunRow's <DisclosureRow> draws them:
                 a narrow pane doesn't re-flow once the runs land. -->
            <Row v-for="(row, index) in ROWS" :key="index" wide-control aria-hidden="true">
                <template #lead="{ mark }">
                    <span class="skeleton h-4 w-4 shrink-0 rounded-full"></span>
                    <span class="skeleton shrink-0 rounded-full" :style="{ width: `${mark}px`, height: `${mark}px` }"></span>
                </template>
                <template #title>
                    <span class="flex h-5 items-center gap-2">
                        <span class="skeleton h-3.5 max-w-full" :class="row.headline"></span>
                        <span class="skeleton h-4 w-14 rounded-md"></span>
                    </span>
                </template>
                <template #description>
                    <span class="flex h-4 items-center gap-2">
                        <span class="skeleton h-2.5" :class="row.author"></span>
                        <span class="skeleton h-2.5 w-10"></span>
                        <span class="skeleton h-2.5 w-12"></span>
                    </span>
                </template>
                <!-- Stage circles and connectors: the row's most distinctive shape, and what a reader scans first. -->
                <template #meta>
                    <span class="flex max-w-max min-w-24 flex-1 basis-0 items-center overflow-x-auto">
                        <template v-for="stage in row.stages" :key="stage">
                            <span v-if="stage > 1" class="h-px w-3 shrink-0 bg-line"></span>
                            <span class="skeleton h-6 w-6 shrink-0 rounded-full"></span>
                        </template>
                    </span>
                </template>
                <template #control>
                    <span class="flex shrink-0 items-center gap-2">
                        <span class="skeleton h-2.5 w-12"></span>
                        <span class="skeleton h-6 w-24 rounded-md"></span>
                        <span class="skeleton mx-1 h-3 w-3"></span>
                    </span>
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
