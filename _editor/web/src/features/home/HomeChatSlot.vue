<!-- The master view's chat area (desktop): lends the shell's chat panel this page, as the /chat section and a popped-out
     window do (ChatSection.vue, FloatingSection.vue), so the home conversation is drawn by the very panel every other chat
     is, on its own surface, with its usage rail. PoppablePanels.vue mounts it here without its tab row, pinned to the home
     conversation (models/home/homeChat.ts), whether or not the shell's own chat is popped out into another window. -->
<script setup lang="ts">
import { useTemplateRef } from "vue";
import { chatFullSlot, publishSlot } from "../../workbench/window/panelSlots";

const slot = useTemplateRef(`slot`);
publishSlot(chatFullSlot, () => slot.value);
</script>

<template>
    <div class="grid min-h-0 flex-1" style="grid-template-areas: &quot;chat&quot;; grid-template-columns: 1fr; grid-template-rows: 1fr">
        <div ref="slot" class="contents"></div>
    </div>
</template>
