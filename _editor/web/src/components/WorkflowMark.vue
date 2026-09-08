<script setup lang="ts">
import type { AgentSummary } from "@intentic/sandbox-contract";

// Marks a conversation as one step of a workflow run, in OriginMark's slot and grammar. Text, not a link: a
// run-page link on a card whose own click means 'focus this chat' made the provenance line the most clickable
// thing on it. Renders nothing for an ordinary conversation; `compact` drops the step title where there's no width for
// it.

defineProps<{ workflow?: NonNullable<AgentSummary["workflow"]>; compact?: boolean }>();
</script>

<template>
    <span v-if="workflow !== undefined" class="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
        <Icon name="sitemap" class="shrink-0 text-2xs" />
        <span class="shrink-0 font-medium">{{ workflow.name }}</span>
        <!-- "step 3/4" rather than a bare "3/4", to match the loop line's "Iteration 2/6" format directly below it. -->
        <span class="shrink-0">· step {{ workflow.index }}/{{ workflow.total }}</span>
        <template v-if="compact !== true">
            <span>·</span>
            <span class="truncate">{{ workflow.step }}</span>
        </template>
    </span>
</template>
