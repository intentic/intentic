<script setup lang="ts">
import { computed } from "vue";
import MemoryPage from "../../features/sandbox/agent-settings/memory/MemoryPage.vue";
import { MEMORY_SIDE_VIEW, MemorySideInputSchema } from "../../features/sandbox/agent-settings/memory/memorySide";
import { keepTab, type SideInput, sideTabId } from "../../workbench/side/sideTabs";

// A memory file's page beside the section: opened from Settings as a look the next press replaces, and kept once
// something is typed into it.

const { input } = defineProps<{ input: SideInput }>();

const parsed = computed(() => MemorySideInputSchema.safeParse(input).data);
const keep = (): void => keepTab(sideTabId(MEMORY_SIDE_VIEW, input));
</script>

<template>
    <MemoryPage v-if="parsed !== undefined" :key="parsed.path" :path="parsed.path" @edited="keep" />
</template>
