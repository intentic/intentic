<!-- The failure an agent card ended on, in ONE line (AgentCard): the corner already names the kind, so this is its gist in
     the card's own ink, and only the glyph wears the tone. One line, so the glyph centres on it rather than hanging off a
     wrapped paragraph's first line. The hover is the kind over the words whole; on a chip naming the same failure, the
     same card. -->
<script setup lang="ts">
import type { CardLine } from "../../../../../models/agent-status/agentStatus-chips";

defineProps<{ failure: CardLine; dense?: boolean }>();
</script>

<template>
    <p
        v-tooltip.top="failure.tip"
        class="flex min-w-0 max-w-full items-center gap-1.5 text-2xs leading-4 text-muted"
        :class="dense ? 'w-full' : ''"
        data-failure
        :data-moved="failure.moved"
    >
        <Icon :name="failure.icon" class="shrink-0 text-2xs" :class="failure.ink" />
        <span class="min-w-0 flex-1 truncate">{{ failure.gist }}</span>
    </p>
</template>
