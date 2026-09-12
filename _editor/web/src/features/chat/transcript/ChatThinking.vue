<script setup lang="ts">
import { computed, ref } from "vue";

// Fold for a turn's thinking, shared by the conversation (ChatMessageView) and a delegated agent's record
// (Subagents.vue) so both render it the same way. Open while streaming, closed once it lands, unless overridden; the
// override is per-instance and unset by default.

const props = defineProps<{
    thinking: string;
    // Whether the turn is still being written; decides the default fold and whether the header may spin.
    streaming: boolean;
}>();

const override = ref<boolean>();
const open = computed(() => override.value ?? props.streaming);
const toggle = (): void => {
    override.value = !open.value;
};
</script>

<template>
    <div class="w-full overflow-hidden rounded-lg">
        <button type="button" class="flex w-full items-center gap-1.5 px-2 py-1 text-2xs uppercase tracking-wide text-subtle" @click="toggle">
            <Icon class="text-2xs" :name="open ? 'chevron-down' : 'chevron-right'" />
            <span>Thinking</span>
            <Icon v-if="streaming" name="spinner" class="text-2xs" spin />
        </button>
        <!-- Capped height and scrolled, not clamped, so reasoning stays reachable without moving the answer below it. -->
        <div v-if="open" class="scrollbar-thin max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-2 text-xs leading-relaxed text-muted">
            {{ thinking }}
        </div>
    </div>
</template>
