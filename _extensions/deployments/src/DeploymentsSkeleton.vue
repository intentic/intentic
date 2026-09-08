<script setup lang="ts">
import { RowGroup } from "@intentic/extension-ui";

// Shape of the loading answer, not a spinner or a loading sentence: sized so the page doesn't reflow when data lands.
// Uses the same <RowGroup> the board uses, in its loading form, so the two can't drift apart. Row widths are fixed, not
// random, so the skeleton doesn't reshuffle every render.

const ROWS = [{ name: `w-32` }, { name: `w-44` }, { name: `w-24` }, { name: `w-40` }] as const;
</script>

<template>
    <!-- aria-busy, not aria-hidden: a screen reader should hear "loading", not silence that reads as an empty board. -->
    <div role="status" aria-busy="true" aria-label="Loading deployments">
        <!-- One host group is the floor; h-4 bars match the label's line height (text-xs) so the heading doesn't jump. -->
        <RowGroup>
            <template #label>
                <span class="flex h-4 items-center gap-3">
                    <span class="skeleton h-3 w-28"></span>
                    <span class="skeleton h-3.5 w-12 rounded-full"></span>
                    <span class="skeleton h-1.5 w-12 rounded-full"></span>
                    <span class="skeleton h-1.5 w-12 rounded-full"></span>
                </span>
            </template>

            <div v-for="(row, index) in ROWS" :key="index" class="flex w-full items-center gap-3 border-l-4 border-line px-4 py-3">
                <span class="skeleton h-4 w-4 shrink-0 rounded-full"></span>

                <!-- Matches the real name/status line heights (text-sm, text-2xs) so the list doesn't shift when data lands. -->
                <div class="min-w-0 flex-1">
                    <div class="flex h-5 items-center gap-2">
                        <span class="skeleton h-3.5 max-w-full" :class="row.name"></span>
                        <span class="skeleton h-4 w-10 rounded"></span>
                    </div>
                    <div class="mt-0.5 flex h-4 items-center gap-2">
                        <span class="skeleton h-2.5 w-20"></span>
                        <span class="skeleton h-2.5 w-28"></span>
                    </div>
                </div>

                <div class="flex shrink-0 items-center gap-1">
                    <span class="skeleton h-6 w-16 rounded-md"></span>
                    <span class="skeleton h-6 w-14 rounded-md"></span>
                    <span class="skeleton h-6 w-6 rounded-md"></span>
                </div>
            </div>
        </RowGroup>
    </div>
</template>
