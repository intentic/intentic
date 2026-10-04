<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { usePaneView } from "./useChat-view";

// What the runtime's own extensions show while the turn runs (sandbox-contract events/agent-ui.ts): one quiet line per
// status entry, just above the composer, under the extensions glyph so it never reads as the agent's own words. Live
// state only: the entries go when the turn settles (TurnClient.agentStatus), and a notice an extension said lands in
// the transcript instead.

const t = useT();
const { conversation } = usePaneView();

const entries = computed(() => [...conversation.value.turn.agentStatus.value.entries()].map(([key, entry]) => ({ key, ...entry })));
</script>

<template>
    <div
        v-if="entries.length > 0"
        class="flex flex-col gap-1 px-3 text-2xs text-subtle"
        role="status"
        :aria-label="t(`chat.chatAgentStatus.label`)"
        data-agent-status
    >
        <div v-for="entry in entries" :key="entry.key" class="flex min-w-0 items-start gap-2">
            <Icon name="extensions" class="mt-px shrink-0 text-2xs" />
            <span v-if="entry.source" class="shrink-0 font-medium text-muted">{{ entry.source }}</span>
            <!-- A widget is several lines; past four it is a panel this row is not, and the whole of it is a hover away. -->
            <span class="line-clamp-4 min-w-0 whitespace-pre-wrap" v-tooltip.top.overflow="entry.text">{{ entry.text }}</span>
        </div>
    </div>
</template>
