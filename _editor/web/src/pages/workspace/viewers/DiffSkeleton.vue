<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { computed } from "vue";
import { useLayout } from "../../../composables/useLayout";

/* The outline of a diff whose content has not arrived yet: what a `pending` tab shows instead of an empty pane.
 *
 * Drawn as the layout the content will occupy, for the same reason the transcript's outline is: the reader
 * already knows which file they clicked (the strip says so, and the toolbar above this has the status letter and
 * the ± counts), so the only thing left to say is "the panes are coming, and there are two of them". A spinner in
 * the middle of the area would say less and then hand the reader a re-anchor when the code appears at the top.
 *
 * The pane split follows the same preference the real viewer reads, so the outline cannot promise a layout the
 * diff then contradicts.
 *
 * Nothing here is armed with a timer or a slow state: this outline is only ever mounted through the workspace's
 * loading reveal, which does not draw it at all for an answer that lands in the first beat, and a warmed diff
 * lands in the same tick as the click. */

const { mobile } = useDevice();
const { diffLayout } = useLayout();
const split = computed(() => !mobile.value && diffLayout.value === `split`);

// Code-shaped line widths: a fixed uneven set, indented the way a file is. Fixed rather than random because an
// outline that reshuffles on every re-render is an animation nobody asked for.
const LINES = [
    { width: `w-5/6`, indent: `` },
    { width: `w-2/3`, indent: `ml-4` },
    { width: `w-3/4`, indent: `ml-4` },
    { width: `w-1/2`, indent: `ml-8` },
    { width: `w-4/5`, indent: `ml-8` },
    { width: `w-1/3`, indent: `ml-4` },
    { width: `w-2/3`, indent: `ml-4` },
    { width: `w-1/2`, indent: `ml-8` },
    { width: `w-3/5`, indent: `ml-4` },
    { width: `w-1/4`, indent: `` },
    { width: `w-4/5`, indent: `` },
    { width: `w-1/2`, indent: `ml-4` },
];
</script>

<template>
    <!-- The bars are decoration; role=status plus the sr-only line carry it to the readers who need it said. -->
    <div class="flex h-full min-h-0 overflow-hidden" role="status" aria-busy="true">
        <span class="sr-only">Reading the file…</span>
        <div
            v-for="pane in split ? 2 : 1"
            :key="pane"
            class="flex min-w-0 flex-1 animate-pulse flex-col gap-2 overflow-hidden border-line p-4 not-first:border-l"
            aria-hidden="true"
        >
            <span v-for="(line, index) in LINES" :key="index" class="flex items-center gap-3">
                <!-- The gutter, which every pane has whatever the layout: the line numbers are the one column a
                     reader can count on being there. -->
                <span class="h-2 w-4 shrink-0 rounded bg-content/10" />
                <span class="h-2 rounded bg-content/10" :class="[line.width, line.indent]" />
            </span>
        </div>
    </div>
</template>
