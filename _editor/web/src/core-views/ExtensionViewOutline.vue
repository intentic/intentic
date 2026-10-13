<!-- What an extension view's host draws while a view never seen in this sandbox is on its way: the page shape most views have, a header and a few rows. Once the view has drawn, its imprint replaces this for good. -->
<script setup lang="ts">
import { Page, PageHeader, RowGroup, SkeletonRows } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { title } = defineProps<{
    /** The activation's own title once it is known; before that the heading is a bar, never a guess. */
    title?: string | undefined;
}>();
</script>

<template>
    <Page>
        <PageHeader v-if="title !== undefined" :title="title" />
        <!-- h-8 is the h1's line (text-2xl), so the real heading lands without moving the rows under it. -->
        <div v-else class="mb-4 flex h-8 items-center" aria-hidden="true">
            <span class="skeleton block h-6 w-48" />
        </div>
        <!-- The one status region for the wait: the rows themselves are decoration (SkeletonRows marks them aria-hidden). -->
        <div role="status" aria-busy="true" :aria-label="t(`views.extensionView.loading`)">
            <RowGroup>
                <SkeletonRows :rows="4" description />
            </RowGroup>
        </div>
    </Page>
</template>
