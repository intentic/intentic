<!--
    The review's shape while its first read is in flight: the file list beside the diff, in the columns and at the
    heights <AgentReviewPanel> draws once the daemon answers, so rows land where the bars stood instead of pushing a
    sentence out of the way. The list keeps the reader's own stored width, and a phone gets the list alone, exactly as
    the real panel splits them.

    One `role="status"` for the whole wait, with the sentence read rather than printed: the bars are decoration, and a
    per-bar announcement would say nothing sixty times. Reveal-delay and minimum-hold timing belong to the caller
    (useLoadingReveal), so a warm read paints none of this.
-->
<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import DiffSkeleton from "../../workspace/viewers/DiffSkeleton.vue";
import { useLayout } from "../../../shell/window/useLayout";
import { uiLength } from "../../../shell/window/uiScale";

const { label, rows = 7 } = defineProps<{
    /** What is being waited on, announced once for the whole outline. */
    label: string;
    /** How many file rows to promise. Match the shortest review worth drawing, not the longest one seen. */
    rows?: number;
}>();

const { mobile } = useDevice();
const shell = useLayout();

// Walked in order and wrapped, so no two rows share a length: a review is a list of paths, not a stack of bars.
const NAME_WIDTHS = [`w-40`, `w-28`, `w-52`, `w-36`, `w-44`, `w-24`, `w-48`];
</script>

<template>
    <div class="flex min-h-0 flex-1" role="status" aria-busy="true">
        <span class="sr-only">{{ label }}</span>
        <aside
            class="flex min-h-0 min-w-0 flex-col"
            :class="mobile ? `flex-1` : `shrink-0 border-r border-line`"
            :style="mobile ? undefined : { width: uiLength(shell.reviewListWidth.value) }"
            aria-hidden="true"
        >
            <!-- The list's own bar: count or filter on the left, totals and the viewed tally on the right. -->
            <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2 max-md:h-12">
                <span class="skeleton block h-3 w-14" />
                <span class="flex-1"></span>
                <span class="skeleton block h-2.5 w-12" />
                <span class="skeleton block h-2.5 w-8" />
            </div>
            <div class="min-h-0 flex-1 overflow-hidden">
                <!-- One repo heading over its rows: the shape every review has, whatever it turns out to hold. -->
                <div class="flex items-center gap-1.5 border-b border-line/60 px-2 py-1">
                    <span class="skeleton block h-2 w-2 shrink-0" />
                    <span class="skeleton block h-2.5 w-20" />
                    <span class="skeleton block h-3 w-8 rounded-full" />
                </div>
                <div
                    v-for="index in rows"
                    :key="index"
                    class="flex items-center gap-2 border-l-2 border-transparent py-1.5 pl-2 pr-1.5 max-md:min-h-11"
                >
                    <!-- Status mark, file glyph, name, size: the four things every row in this list carries. -->
                    <span class="skeleton block h-2.5 w-2.5 shrink-0" />
                    <span class="skeleton block h-3 w-3 shrink-0" />
                    <span class="skeleton block h-2.5" :class="NAME_WIDTHS[(index - 1) % NAME_WIDTHS.length]" />
                    <span class="flex-1"></span>
                    <span class="skeleton block h-2.5 w-10 shrink-0" />
                </div>
            </div>
        </aside>

        <!--
            Desktop opens on the first file, so the diff half is part of what this wait is for; a phone's diff is a
            full-screen takeover that only a pick can reach, and promising one here would promise a screen that isn't
            coming.
        -->
        <section v-if="!mobile" class="flex min-h-0 min-w-0 flex-1 flex-col" aria-hidden="true">
            <!-- The diff's toolbar, at the list header's height: the two align in the real panel. -->
            <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2 max-md:h-12">
                <span class="skeleton block h-2.5 w-2.5 shrink-0" />
                <span class="skeleton block h-2.5 w-44" />
                <span class="flex-1"></span>
                <span class="skeleton block h-2.5 w-14" />
                <span class="skeleton block h-5 w-24 rounded-md" />
            </div>
            <!-- The workspace editor's own diff outline, so a waiting diff looks the same wherever it is opened. -->
            <DiffSkeleton bare class="min-h-0 flex-1" />
        </section>
    </div>
</template>
