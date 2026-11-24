<!-- The commit graph's rows while the log is read: the graph row's own height and columns, so the panel does not re-flow when it lands. -->
<script setup lang="ts">
import { t } from "../i18n.js";

const { rowHeight, laneWidth } = defineProps<{
    /** The graph row's fixed height, which its lanes are drawn to. */
    rowHeight: number;
    /** One lane's width: the gutter a linear history draws. */
    laneWidth: number;
}>();

// Fixed, not random: a subject line's length varies, and a run of equal bars reads as a rendering artifact.
const SUBJECTS = [`w-64`, `w-48`, `w-72`, `w-56`];
</script>

<template>
    <div role="status" aria-busy="true">
        <span class="sr-only">{{ t(`gitHistoryTab.readingRepositorysHistory`) }}</span>
        <!-- One lane's dot, the subject, then the author, the time and the short sha as the panel's width allows them, as
             GitHistoryTab's row hides them. `@container` on the row, which the real rows' wrapper carries. -->
        <div v-for="row in 12" :key="row" class="@container flex items-center gap-2 px-3" :style="{ height: `${rowHeight}px` }" aria-hidden="true">
            <span class="flex shrink-0 justify-center" :style="{ width: `${laneWidth}px` }">
                <span class="skeleton block h-2 w-2 rounded-full" />
            </span>
            <span class="min-w-0 flex-1">
                <span class="skeleton block h-2.5 max-w-full" :class="SUBJECTS[row % SUBJECTS.length]" />
            </span>
            <span class="skeleton hidden h-2 w-20 shrink-0 @2xl:block" />
            <span class="skeleton hidden h-2 w-12 shrink-0 @md:block" />
            <span class="skeleton block h-2 w-11 shrink-0" />
        </div>
    </div>
</template>
