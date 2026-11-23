<!-- Loading outline for a <SplitView>-shaped route (asyncView) while its chunk loads; title and description are passed in at registration. -->
<script setup lang="ts">
import { SkeletonRows, SplitView } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const {
    railRows = 8,
    bodyRows = 4,
    search = false,
} = defineProps<{
    /** The page's real heading: a static string the route table already knows, never a guess. */
    title: string;
    description?: string;
    /** How many index rows to promise. Match the shortest index the page actually shows. */
    railRows?: number;
    bodyRows?: number;
    /** Whether the index opens with a filter field, as a hub's does: promised, so the rows below it do not jump down by a field's height. */
    search?: boolean;
}>();

// Walked in order, so the folded strip's pills are uneven the way real section names are.
const PILL_WIDTHS = [`w-20`, `w-16`, `w-24`, `w-14`, `w-20`];
</script>

<template>
    <SplitView :title="title" :description="description" scroll="page">
        <template #compact>
            <div class="flex gap-2 overflow-hidden border-b border-line-subtle pb-2" aria-hidden="true">
                <span v-for="(width, index) in PILL_WIDTHS" :key="index" class="skeleton block h-6 shrink-0 rounded-full" :class="width" />
            </div>
        </template>
        <!-- The index as <NavRail> lays it out, so the real one lands on these bars: the pinned field and the rows' column
             each keep the scroll's `pr-2` gutter, and a group's label stands on the label's own inset and gap. -->
        <template #rail>
            <div class="ui-nav-index flex flex-col" aria-hidden="true">
                <div v-if="search" class="pb-3 pr-2"><span class="skeleton block h-8 rounded-lg" /></div>
                <div class="pr-2">
                    <span class="mb-1 flex h-4 items-center px-2"><span class="skeleton block h-2.5 w-16" /></span>
                    <div class="flex flex-col gap-0.5"><SkeletonRows :rows="railRows" density="dense" lead /></div>
                </div>
            </div>
        </template>
        <template #detail>
            <!-- The one status region for the whole wait: the bars themselves are decoration (SkeletonRows marks its rows aria-hidden). -->
            <div role="status" aria-busy="true" :aria-label="t(`common.splitViewOutline.loading`)">
                <SkeletonRows :rows="bodyRows" description />
            </div>
        </template>
    </SplitView>
</template>
