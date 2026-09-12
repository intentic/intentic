<script setup lang="ts">
import ChatFold from "./ChatFold.vue";

// The thinking preset of ChatFold, shared by the conversation (ChatMessageView) and a delegated agent's record
// (Subagents.vue) so both read the same. Open while the turn writes it, shut once it lands, unless the reader says
// otherwise. `sparkles` is the mark the think tool already carries (toolPresentation.ts).

defineProps<{
    thinking: string;
    // Whether the turn is still being written; decides the default fold and whether the header spins.
    streaming: boolean;
}>();
</script>

<template>
    <ChatFold icon="sparkles" label="Thinking" :open-by-default="streaming" :busy="streaming">
        <p class="whitespace-pre-wrap">{{ thinking }}</p>
    </ChatFold>
</template>
