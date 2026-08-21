<script setup lang="ts">
import { computed } from "vue";
import type { ChatTool } from "../composables/chat/transcript";
import ChatToolCard from "./ChatToolCard.vue";
import ChatToolGroup from "./ChatToolGroup.vue";
import { type ToolEntry, groupConsecutiveTools } from "./toolGrouping";

/* A run of tool calls as rows: the count-grouping (toolGrouping.ts) and the card-or-group choice, in one
 * place. Extracted so the transcript's two readings render calls through the SAME component: the mode that
 * shows them inline, and a hidden run somebody has just opened. What "shown" looks like is then one definition
 * rather than two that drift. */

const props = defineProps<{
    tools: readonly ChatTool[];
    live: boolean;
}>();

// Consecutive same-name+same-target tool calls collapsed into summary rows (see toolGrouping.ts).
const entries = computed((): readonly ToolEntry[] => groupConsecutiveTools(props.tools));
</script>

<template>
    <template v-for="(entry, index) in entries" :key="'kind' in entry ? `g-${index}` : entry.id">
        <ChatToolGroup v-if="'kind' in entry" :group="entry" :live="live" />
        <ChatToolCard v-else :tool="entry as ChatTool" :live="live" />
    </template>
</template>
