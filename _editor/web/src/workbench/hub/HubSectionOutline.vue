<!-- What a hub draws in a section's place while a section never seen here is on its way (lazySection.ts): the body half of the hub's own route outline (SplitViewOutline.vue), so a cold load goes from that outline to this one with the rows where they were. Once the section has drawn, its imprint replaces this for good. -->
<script setup lang="ts">
import { SkeletonRows } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();
</script>

<template>
    <!-- The one status region for the wait: the rows themselves are decoration (SkeletonRows marks them aria-hidden). -->
    <div role="status" aria-busy="true" :aria-label="t(`ui.status.loading`)">
        <SkeletonRows :rows="4" description />
    </div>
</template>
