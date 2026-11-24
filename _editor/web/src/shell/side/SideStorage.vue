<script setup lang="ts">
import { computed } from "vue";
import StoragePage from "../../features/sandbox/overview/storage/StoragePage.vue";
import { STORAGE_SIDE_VIEW, type StoragePageKey, StorageSideInputSchema, storageSideInput } from "../../features/sandbox/overview/storage/storageSide";
import type { SideInput } from "../../workbench/side/sideTabs";
import { revealSideView } from "../../workbench/side/sideViews";

// A category of the Disk card's map beside the Overview, opened as a look the next press replaces. The "smaller" page's
// rows open their own page the same way.

const { input } = defineProps<{ input: SideInput }>();

const parsed = computed(() => StorageSideInputSchema.safeParse(input).data);
const open = (category: StoragePageKey): void => void revealSideView(STORAGE_SIDE_VIEW, storageSideInput(category));
</script>

<template>
    <StoragePage v-if="parsed !== undefined" :key="parsed.category" :category="parsed.category" @open="open" />
</template>
