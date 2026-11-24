<!-- The body of a page never seen here, while its code is on its way: a hub's section (lazySection.ts) and a SplitView-shaped route's detail (SplitViewOutline.vue) draw the same one, so a cold load goes from the route's outline to the section's with the rows where they were. Once the page has drawn, its imprint replaces this for good. -->
<script setup lang="ts">
import { RowGroup, SkeletonRows } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { label } = defineProps<{
    /** What a screen reader hears while it stands; the kit's "Loading…" by default. */
    label?: string;
}>();

// Most pages are labelled groups of described rows, one card each, stacked as the pages stack them (`gap-6`). Bare rows
// on the page drew every section as one unlabelled list, and the real groups landed below and beside them.
const GROUPS = [
    { rows: 3, label: `w-24` },
    { rows: 2, label: `w-32` },
];
</script>

<template>
    <!-- The one status region for the wait: the rows themselves are decoration (SkeletonRows marks them aria-hidden). -->
    <div role="status" aria-busy="true" :aria-label="label ?? t(`ui.status.loading`)" class="flex flex-col gap-6">
        <RowGroup v-for="group in GROUPS" :key="group.label">
            <template #label><span class="skeleton block h-2.5" :class="group.label" aria-hidden="true" /></template>
            <SkeletonRows :rows="group.rows" description />
        </RowGroup>
    </div>
</template>
