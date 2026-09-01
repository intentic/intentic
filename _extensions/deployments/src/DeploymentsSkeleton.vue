<script setup lang="ts">
import { RowGroup, StatusTally } from "@intentic/extension-ui";

/* What the Deployments view shows before its first /komodo/overview response: the SHAPE of the answer, not a
 * spinner and not the sentence "Reading your deployments…", which is a line of text where a board is about to
 * be and moves everything under it the moment the data lands.
 *
 * The tally line and the host group are drawn with the SAME kit components the board itself uses, in their
 * loading form (<StatusTally skeleton>, <RowGroup>): a second copy of their markup is what a change to either
 * would leave behind, and this outline exists precisely to not drift from what lands.
 *
 * The geometry is a deliberate copy of the real thing: tally line, one host group with its meta strip, rows
 * with a state glyph, a name, a status line and two action buttons, so the page settles once. Row widths vary
 * because a column of identical bars reads as a rendering artifact rather than as a list of container names;
 * they are fixed rather than random, since a placeholder that reshuffles on every re-render is worse than one
 * that repeats. */

const ROWS = [{ name: `w-32` }, { name: `w-44` }, { name: `w-24` }, { name: `w-40` }] as const;
</script>

<template>
    <!-- aria-busy over aria-hidden: a screen reader should hear "this region is loading", not silence that is
         indistinguishable from an empty board. The bars carry no text, so there is nothing to read. -->
    <div role="status" aria-busy="true" aria-label="Loading deployments">
        <StatusTally :skeleton="3" class="mb-5" />

        <!-- One host group. A second would be a guess about the user's infrastructure; one is the floor.
             h-4 is the line box of the label the bars stand in for (`text-xs`), so the group heading holds
             its height; the three shorter bars are the host's meta strip (ServerMeta), which rides the same
             heading row in the board. -->
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

                <!-- h-5 / h-4 with an h-0.5 gap is exactly what the real name (text-sm) and status line
                     (text-2xs, mt-0.5) measure, so the list does not shuffle upward when the board lands. -->
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
