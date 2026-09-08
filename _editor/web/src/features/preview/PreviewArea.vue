<!--
    Full-screen /preview route, desktop only: publishes the dock slot the preview panel teleports into (shell/dockSlots.ts), the same contract as
    ChatArea.vue. Parked behind the rail's Preview tile, the panel's iframe keeps its state. When the preview is in its own window, this area shows a
    notice with an explicit recall button — never automatic.
-->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { onMounted, onUnmounted, useTemplateRef } from "vue";
import { markPreviewOpened } from "./previewSurface";
import { usePreviewFloating } from "./previewFloating";
import { previewDock } from "../../shell/window/dockSlots";

const { floats, dock } = usePreviewFloating();

// Standing here is what makes the panel exist at all (previewSurface.opened): a bookmark or a hand-typed
// /preview arrives without any control having marked it, and an area publishing a slot nothing mounts into
// would be a blank page.
markPreviewOpened();

const slot = useTemplateRef(`slot`);
onMounted(() => {
    previewDock.value = slot.value;
});
onUnmounted(() => {
    previewDock.value = null;
});
</script>

<template>
    <div class="relative h-full w-full">
        <!-- Published even while another window holds the panel, so "Bring it back here" lands it in this slot
             the instant the window goes: no hop through the parking stage. -->
        <div ref="slot" class="contents"></div>
        <div v-if="floats" class="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <Icon name="external-link" class="text-3xl text-subtle" />
            <div>
                <p class="text-sm font-medium text-content">Your preview is in its own window</p>
                <p class="mt-1 text-xs text-muted">Bring it back to fill this one, or keep the app beside your code on another screen.</p>
            </div>
            <Button size="small" @click="dock()"> <Icon name="sign-in" />Bring it back here </Button>
        </div>
    </div>
</template>
