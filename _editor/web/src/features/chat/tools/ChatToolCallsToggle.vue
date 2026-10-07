<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { usePaneView } from "../panel/useChat-view";
import { toolCallsNote, useToolCalls } from "./useToolCalls";
import { useT } from "@intentic/ui/i18n";

// One control for whether a transcript shows its tool calls, under the chat pane's composer (ChatPaneStatus). A hammer
// alone, struck through when hidden; state is the slash, not brightness, so it doesn't out-glow the numbers beside it.
// Inherits its host's ink rather than naming its own color.

const t = useT();

const { showToolCalls } = useToolCalls();
const { messages } = usePaneView();

// Every call this pane's transcript holds: what the press shows or folds here, one row each.
const calls = computed(() => messages.value.reduce((total, message) => total + (message.tools?.length ?? 0), 0));

// What the press just did to this chat, said over the hammer for a moment and gone: the slash alone said the switch
// moved, not what it moved, and a reader whose chat held one call toggled it eight times looking for the difference.
const SAID_MS = 2_500;
const said = ref<string>();
let saidTimer: ReturnType<typeof setTimeout> | undefined;
const toggle = (): void => {
    showToolCalls.value = !showToolCalls.value;
    said.value = toolCallsNote(showToolCalls.value, calls.value);
    clearTimeout(saidTimer);
    saidTimer = setTimeout(() => (said.value = undefined), SAID_MS);
};
onBeforeUnmount(() => clearTimeout(saidTimer));
</script>

<template>
    <span class="relative inline-flex">
        <button
            type="button"
            class="touch-target relative inline-flex cursor-pointer items-center transition-colors hover:text-content"
            :aria-pressed="showToolCalls"
            :aria-label="showToolCalls ? t(`chat.chatToolCallsToggle.hideToolCalls`) : t(`chat.words.showToolCalls`)"
            v-tooltip.top="showToolCalls ? t(`chat.chatToolCallsToggle.hideTools`) : t(`chat.chatToolCallsToggle.showTools`)"
            @click="toggle"
        >
            <Icon name="hammer" class="rotate-[35deg] text-xs" />
            <span
                v-if="!showToolCalls"
                aria-hidden="true"
                class="pointer-events-none absolute top-1/2 left-1/2 h-px w-[130%] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current"
            />
        </button>
        <!-- Drawn as a hover label is, where one stands, so it moves nothing in the row; the live region outlives the words in it. -->
        <span role="status" class="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap">
            <span v-if="said !== undefined" class="ui-tooltip-body block">{{ said }}</span>
        </span>
    </span>
</template>
