<script setup lang="ts">
import type { IconName, TooltipValue } from "@intentic/ui";

// One figure on the spine down the column's left edge (`.chat-spine-node` in chat.css): a glyph and a count, no plate.
// A run of tool calls (ChatTurnAsides) and the context a message went out with (ChatNotes) both stand as one, so the
// left edge speaks one language; where it stands is its host's business, what it looks like is this.

defineProps<{
    icon?: IconName;
    count?: number;
    // Whether what it stands for is open under it.
    open: boolean;
    // What a press opens, for the screen reader and a pointer that has not reached it yet.
    label: string;
    tip: TooltipValue;
    failed?: boolean;
    // Still being written: the one figure on the spine that moves.
    live?: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
    <button
        type="button"
        class="chat-spine-node touch-target"
        :class="{ 'chat-spine-node-on': open, 'chat-spine-node-failed': failed, 'chat-spine-node-live': live }"
        :aria-expanded="open"
        :aria-label="label"
        v-tooltip.left="tip"
        @click="emit(`toggle`)"
    >
        <Icon v-if="icon" :name="icon" class="text-2xs" />
        <template v-if="count !== undefined">{{ count }}</template>
    </button>
</template>
