<!-- The review's frame while its first read is in flight: the list's column and the diff's, empty, and one line saying what is on its way. -->
<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { useLayout } from "../../../workbench/window/useLayout";
import { uiLength } from "../../../workbench/window/uiScale";
import ReviewWaitLine from "./ReviewWaitLine.vue";

// No rows or code lines are drawn. Every agent's review is different (two files or two hundred, a one-line fix or a
// rewrite), so any rows here would be a guess the answer then contradicts, and a page of bars to tear down. What
// every review does share is its frame: the list column at the reader's width, its header and the diff toolbar at
// the same height. Holding that keeps the answer from moving anything when it lands.

const { label } = defineProps<{
    /** What is being waited on, said once for the whole frame. */
    label: string;
}>();

const { mobile } = useDevice();
const shell = useLayout();
</script>

<template>
    <div class="flex min-h-0 flex-1">
        <aside
            class="flex min-h-0 min-w-0 flex-col"
            :class="mobile ? `flex-1` : `shrink-0 border-r border-line`"
            :style="mobile ? undefined : { width: uiLength(shell.reviewListWidth.value) }"
        >
            <div class="h-8 shrink-0 border-b border-line max-md:h-12" aria-hidden="true"></div>
            <ReviewWaitLine :label="label" class="px-2.5" />
        </aside>
        <!-- Desktop opens the first diff beside the list; a phone reaches it through a pick, so its frame is the list alone. -->
        <section v-if="!mobile" class="flex min-h-0 min-w-0 flex-1 flex-col" aria-hidden="true">
            <div class="h-8 shrink-0 border-b border-line max-md:h-12"></div>
        </section>
    </div>
</template>
