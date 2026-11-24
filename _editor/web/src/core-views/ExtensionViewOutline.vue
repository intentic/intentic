<!-- What an extension view's host draws while a view never seen in this sandbox is on its way: the page shape most views have, a header and labelled groups of rows. Once the view has drawn, its imprint replaces this for good. -->
<script setup lang="ts">
import { SplitView } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import SectionsOutline from "../components/SectionsOutline.vue";

const t = useT();

const { title } = defineProps<{
    /** The activation's own title once it is known; before that the heading is a bar, never a guess. */
    title?: string | undefined;
}>();
</script>

<template>
    <!-- <SplitView>'s undocked shape, which most views with a title draw: the name in the window's top bar, so the real one
         lands where this one stood. An empty title draws a bar in its place. The body is the one a hub's section draws
         while it waits (SectionsOutline.vue): most views are labelled groups of rows too. -->
    <SplitView :title="title ?? ``" scroll="page">
        <template #detail>
            <SectionsOutline :label="t(`views.extensionView.loading`)" />
        </template>
    </SplitView>
</template>
