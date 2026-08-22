<!-- THE PREVIEW AREA: the preview panel's full-window home, desktop only.

     The panel itself is mounted once per page by shell/WorkspaceRuntime's PoppablePanels and TELEPORTED to
     whichever slot is published (shell/dockSlots.ts): this route publishes the preview's one in-shell slot.
     Away from here the panel waits parked behind the rail's Preview tile, its iframe still holding the
     previewed app's own state; nothing preview-shaped is duplicated in this file.

     WHILE THE PREVIEW IS IN A WINDOW OF ITS OWN this area does not steal it: the panel is drawn by that window,
     so the area stands empty and the notice below says where the preview is, with the one explicit way to
     recall it. Never an automatic recall: a URL that happens to be /preview must not close a window under the
     user. Every move of the panel is a button. (The same contract as pages/ChatArea.vue.) -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { onMounted, onUnmounted, useTemplateRef } from "vue";
import { markPreviewOpened } from "../composables/preview/previewSurface";
import { usePreviewFloating } from "../composables/preview/previewFloating";
import { previewDock } from "../shell/dockSlots";

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
