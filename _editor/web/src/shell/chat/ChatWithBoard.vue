<!-- The /chat route on a desktop: the chat section (features/chat/panel/ChatSection.vue), and, when the reader chose it, the
     Agents board standing on its left (ChatBoardColumn.vue, features/chat/panel/board/chatBoard.ts). Composed here rather
     than inside the chat section, since the board's feature already reads the chat's and a feature may not read back. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import ChatSection from "../../features/chat/panel/ChatSection.vue";
import { chatBoardChosen } from "../../features/chat/panel/board/chatBoard";
import { MIN_PANE_PX } from "../../workbench/window/useLayout";
import { uiLength } from "../../workbench/window/uiScale";
import ChatBoardColumn from "./ChatBoardColumn.vue";

// The route's width, for the board's seam, which turns the pointer's pixels into the board's share of it.
const root = useTemplateRef(`root`);
const room = ref(0);
let observer: ResizeObserver | undefined;
onMounted(() => {
    // A component-test DOM has no ResizeObserver: the seam then has no room to work in, and the share stays as stored.
    if (root.value === null || !(`ResizeObserver` in globalThis)) {
        return;
    }
    observer = new ResizeObserver(([entry]) => (room.value = Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
    <div ref="root" class="flex h-full w-full">
        <ChatBoardColumn v-if="chatBoardChosen" :room="room" />
        <!-- The chat keeps at least a pane's width beside the board; alone, it takes the whole route as it always did. -->
        <ChatSection class="min-w-0 flex-1" :style="chatBoardChosen ? { minWidth: uiLength(MIN_PANE_PX) } : undefined" />
    </div>
</template>
