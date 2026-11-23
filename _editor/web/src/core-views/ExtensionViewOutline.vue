<!-- What an extension view's host draws while a view never seen in this sandbox is on its way: the page shape most views have, a header and a few rows. Once the view has drawn, its imprint replaces this for good. -->
<script setup lang="ts">
import { RowGroup, SkeletonRows, SplitView } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { title } = defineProps<{
    /** The activation's own title once it is known; before that the heading is a bar, never a guess. */
    title?: string | undefined;
}>();
</script>

<template>
    <!-- <SplitView>'s undocked shape, which most views with a title draw: the name in the window's top bar, so the real one
         lands where this one stood. An empty title draws a bar in its place. -->
    <SplitView :title="title ?? ``" scroll="page">
        <template #detail>
            <!-- The one status region for the wait: the rows themselves are decoration (SkeletonRows marks them aria-hidden). -->
            <div role="status" aria-busy="true" :aria-label="t(`views.extensionView.loading`)">
                <RowGroup>
                    <SkeletonRows :rows="4" description />
                </RowGroup>
            </div>
        </template>
    </SplitView>
</template>
