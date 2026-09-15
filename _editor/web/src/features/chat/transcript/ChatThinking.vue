<script setup lang="ts">
import { computed } from "vue";
import ChatAside from "./ChatAside.vue";

// The thinking preset of ChatAside, shared by the conversation (ChatMessageView) and a delegated agent's record
// (Subagents.vue) so both read the same. Open while the turn writes it, shut once it lands, unless the reader says
// otherwise. `sparkles` is the mark the think tool already carries (toolPresentation.ts).

const props = defineProps<{
    thinking: string;
    // Whether the turn is still being written; decides the default fold and whether the pill spins.
    streaming: boolean;
}>();

// The opening words, on hover: enough to say what the turn is chewing on without the pill growing to hold it.
const HINT_CHARS = 180;
const hint = computed(() => (props.thinking.length > HINT_CHARS ? `${props.thinking.slice(0, HINT_CHARS).trimEnd()}…` : props.thinking));
</script>

<template>
    <ChatAside icon="sparkles" label="Thinking" :hint="hint" :open-by-default="streaming" :busy="streaming">
        <!-- Boxed exactly as a tool card's output is, so reasoning and doing read as one vocabulary. -->
        <pre class="max-h-64 overflow-auto rounded border border-line bg-canvas px-2 py-1 whitespace-pre-wrap italic">{{ thinking }}</pre>
    </ChatAside>
</template>
