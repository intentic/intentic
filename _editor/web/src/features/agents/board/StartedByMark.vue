<script setup lang="ts">
import { computed } from "vue";

/* "A program started this": the mark for a conversation whose first turn was asked for by a control token (AgentSummary.startedBy is `token:<label>`). */

const props = defineProps<{ startedBy?: string }>();

const TOKEN_PREFIX = `token:`;

const tokenLabel = computed(() => (props.startedBy?.startsWith(TOKEN_PREFIX) === true ? props.startedBy.slice(TOKEN_PREFIX.length) : undefined));
</script>

<template>
    <span
        v-if="tokenLabel !== undefined"
        class="flex min-w-0 items-center gap-1.5 text-2xs text-muted"
        :aria-label="`Started by the control token ${tokenLabel}`"
        v-tooltip.top="`Started by a program holding the control token “${tokenLabel}”`"
    >
        <Icon name="key" class="shrink-0 text-2xs" />
        <span class="shrink-0 font-medium">Token</span>
        <span>·</span>
        <span class="truncate">{{ tokenLabel }}</span>
    </span>
</template>
