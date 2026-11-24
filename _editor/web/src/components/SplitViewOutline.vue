<!-- Loading outline for a <SplitView>-shaped route (asyncView) while its chunk loads; title, description and the index's groups are passed in at registration. -->
<script setup lang="ts">
import { SkeletonRows, SplitView } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import SectionsOutline from "./SectionsOutline.vue";

const t = useT();

const { search = false, labelled = true } = defineProps<{
    /** The page's real heading: a static string the route table already knows, never a guess. */
    title: string;
    description?: string;
    /**
     * How many rows each of the index's groups holds, in order, as the real index draws them (a hub's from its own nav
     * table). One run of rows drew a hub's four labelled groups as one, and every row below the first group landed lower.
     */
    rail: readonly number[];
    /** Whether the index opens with a filter field, as a hub's does: promised, so the rows below it do not jump down by a field's height. */
    search?: boolean;
    /** Whether each group stands under a heading, as a hub's do; an index of bare rows (Capabilities') has none. */
    labelled?: boolean;
}>();

// Walked in order, so the folded strip's pills are uneven the way real section names are.
const PILL_WIDTHS = [`w-20`, `w-16`, `w-24`, `w-14`, `w-20`];
// The groups' headings, uneven for the same reason.
const LABEL_WIDTHS = [`w-16`, `w-24`, `w-14`, `w-20`];
</script>

<template>
    <SplitView :title="title" :description="description" scroll="page">
        <template #compact>
            <div class="flex gap-2 overflow-hidden border-b border-line-subtle pb-2" aria-hidden="true">
                <span v-for="(width, index) in PILL_WIDTHS" :key="index" class="skeleton block h-6 shrink-0 rounded-full" :class="width" />
            </div>
        </template>
        <!-- The index as <NavRail> lays it out, so the real one lands on these bars: the pinned field and the rows' column
             each keep the scroll's `pr-2` gutter, a group's label stands on the label's own inset and gap, and a hairline
             parts each group from the one above it. -->
        <template #rail>
            <div class="ui-nav-index flex flex-col" aria-hidden="true">
                <div v-if="search" class="pb-3 pr-2"><span class="skeleton block h-8 rounded-lg" /></div>
                <div class="pr-2">
                    <section
                        v-for="(rows, index) in rail"
                        :key="index"
                        class="mt-3 border-t border-line-subtle pt-3 first:mt-0 first:border-t-0 first:pt-0"
                    >
                        <span v-if="labelled" class="mb-1 flex h-4 items-center px-2"><span class="skeleton block h-2.5" :class="LABEL_WIDTHS[index % LABEL_WIDTHS.length]" /></span>
                        <div class="flex flex-col gap-0.5"><SkeletonRows :rows="rows" density="dense" lead /></div>
                    </section>
                </div>
            </div>
        </template>
        <template #detail>
            <SectionsOutline :label="t(`common.splitViewOutline.loading`)" />
        </template>
    </SplitView>
</template>
