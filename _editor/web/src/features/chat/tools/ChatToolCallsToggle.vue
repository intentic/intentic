<script setup lang="ts">
import { useToolCalls } from "./useToolCalls";

// One control for whether a transcript shows its tool calls, drawn identically in the chat pane and the
// Subagents strip. A hammer alone, struck through when hidden; state is the slash, not brightness, so it
// doesn't out-glow the numbers beside it. Inherits its host's ink rather than naming its own color.

const { showToolCalls } = useToolCalls();
</script>

<template>
    <button
        type="button"
        class="touch-target relative inline-flex cursor-pointer items-center transition-colors hover:text-content"
        :aria-pressed="showToolCalls"
        :aria-label="showToolCalls ? 'Hide tool calls' : 'Show tool calls'"
        v-tooltip.top="showToolCalls ? 'Hide tool calls' : 'Show tool calls'"
        @click="showToolCalls = !showToolCalls"
    >
        <Icon name="hammer" class="rotate-[35deg] text-xs" />
        <span
            v-if="!showToolCalls"
            aria-hidden="true"
            class="pointer-events-none absolute top-1/2 left-1/2 h-px w-[130%] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current"
        />
    </button>
</template>
