<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useT } from "@intentic/ui/i18n";
import { TRANSCRIPT_HOLD } from "./useStickToBottom";

// A long piece of a tool's output folded to its first lines, fading out, with a press under it for the rest: the
// transcript stays the one thing that scrolls, instead of a short box scrolling inside it. Decided by the line count the
// caller already knows rather than by measuring, so nothing reflows as it lands. The fold is also the horizontal
// scroller, so code keeps its indentation instead of wrapping.

const { lines, limit = 12 } = defineProps<{
    lines: number;
    // Lines shown while folded.
    limit?: number;
}>();

const t = useT();

// Folding away a line or two would cost the reader more than reading them.
const folds = computed(() => lines > limit + 3);
const open = ref(false);

// The press stays under the pointer while the rest opens above it (useStickToBottom's hold), as a card's fold does.
const hold = inject(TRANSCRIPT_HOLD, (_element, change) => change());
const toggle = (event: MouseEvent): void => {
    hold(event.currentTarget, () => {
        open.value = !open.value;
    });
};
</script>

<template>
    <div class="flex min-w-0 flex-col">
        <div class="chat-fold" :class="{ 'chat-fold-shut': folds && !open }" :style="{ '--chat-fold-lines': limit }">
            <slot />
        </div>
        <button
            v-if="folds"
            type="button"
            class="self-start px-2.5 pt-0.5 pb-1.5 text-2xs text-link transition-colors hover:underline"
            :aria-expanded="open"
            @click="toggle"
        >
            {{ open ? t(`chat.chatToolCard.showLess`) : t(`chat.chatToolCard.showAll`, { count: lines }, lines) }}
        </button>
    </div>
</template>
