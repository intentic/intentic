<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { computed } from "vue";
import { useLayout } from "../../../shell/window/useLayout";

// Outline of a diff whose content hasn't arrived (what a `pending` tab shows). Drawn as the eventual layout, not
// a spinner, since the reader already knows which file; the toolbar above already gives status and ± counts. Split
// follows the same preference the real viewer reads, so the outline never promises a layout the diff then contradicts.

const { mobile } = useDevice();
const { diffLayout } = useLayout();
const split = computed(() => !mobile.value && diffLayout.value === `split`);

// Fixed, uneven line widths, indented like code; fixed so the outline doesn't reshuffle on re-render.
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
            class="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden border-line p-4 not-first:border-l"
            aria-hidden="true"
        >
            <span v-for="(line, index) in LINES" :key="index" class="flex items-center gap-3">
                <!-- Gutter appears in every pane regardless of layout: the one column a reader can always count on. -->
                <span class="h-2 w-4 shrink-0 rounded bg-content/10" />
                <span class="h-2 rounded bg-content/10" :class="[line.width, line.indent]" />
            </span>
        </div>
    </div>
</template>
