<script setup lang="ts">
import type { AgentActivity } from "@intentic/sandbox-contract";

/* The card's live "what is it doing" snippet: the current todo when the agent runs a checklist, else the last
 * tool + target. Presentational only — the registry (via useAgents) is the data source. */

const props = defineProps<{ activity: AgentActivity }>();
</script>

<template>
    <p class="truncate text-2xs text-muted">
        <template v-if="props.activity.todo !== undefined">{{ props.activity.todo }}</template>
        <template v-else-if="props.activity.tool !== undefined">
            <span class="font-medium">{{ props.activity.tool }}</span>
            <span v-if="props.activity.target !== undefined" class="text-subtle"> · {{ props.activity.target }}</span>
        </template>
    </p>
</template>
