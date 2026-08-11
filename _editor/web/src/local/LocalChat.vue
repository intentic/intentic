<!-- The LOCAL posture's chat window: a full-viewport dock slot for the one chat panel instance.

     The panel itself is mounted once per page by shell/WorkspaceRuntime's PoppablePanels and TELEPORTED to
     whichever slot is published (shell/dockSlots.ts) — this route publishes one that fills the window, the
     same lending contract the workspace shell's docked column uses. Nothing chat-shaped is duplicated here:
     a streaming turn survives this route unmounting exactly as it survives shell navigation, by parking.

     The grid exists because the panel's own classes were written against the shell grid: it styles itself
     with `grid-area: chat`, so the slot's parent must BE a grid with that area or the panel gets no box. -->
<script setup lang="ts">
import { onMounted, onUnmounted, useTemplateRef } from "vue";
import { chatDock } from "../shell/dockSlots";

const slot = useTemplateRef(`slot`);
onMounted(() => {
    chatDock.value = slot.value;
});
onUnmounted(() => {
    chatDock.value = null;
});
</script>

<template>
    <!-- h-dvh, not h-full: this route mounts straight under the router outlet, where no ancestor carries a
         height — 100% of nothing left the panel hugging its content with dead space below. -->
    <div class="grid h-dvh w-full" style="grid-template-areas: 'chat'; grid-template-columns: 1fr; grid-template-rows: 1fr">
        <div ref="slot" class="contents"></div>
    </div>
</template>
