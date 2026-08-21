<!-- THE PREVIEW AREA: the preview panel's full-window home, desktop only.

     The panel itself is mounted once per page by shell/WorkspaceRuntime's PoppablePanels and TELEPORTED to
     whichever slot is published (shell/dockSlots.ts): this route publishes the preview's one in-shell slot.
     Away from here the panel waits parked behind the rail's Preview tile, its iframe still holding the
     previewed app's own state; nothing preview-shaped is duplicated in this file.

     WHILE THE PREVIEW FLOATS IN ITS OWN WINDOW this area does not steal it: the pop-out outranks this slot,
     so the area stands empty and the notice below says where the preview is, with the one explicit way to
     recall it. An automatic recall here would race the reload path: a surviving pop-out window is re-adopted
     on load, and a URL that happens to be /preview must not close it under the user. Every move of the panel
     is a button. (The same contract as pages/ChatArea.vue, for the same reasons.) -->
<script setup lang="ts">
import Button from "primevue/button";
import { onMounted, onUnmounted, useTemplateRef } from "vue";
import { markPreviewOpened } from "../composables/preview/previewSurface";
import { usePreviewPopout } from "../composables/preview/usePreviewPopout";
import { previewDock } from "../shell/dockSlots";

const { poppedOut, restoring, dock } = usePreviewPopout();

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
        <!-- Published even while the pop-out holds the panel, so "Bring it back here" lands the panel in this
             slot the instant the dock happens: no remount, no hop through the parking stage. -->
        <div ref="slot" class="contents"></div>
        <div v-if="poppedOut || restoring" class="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <Icon name="external-link" class="text-3xl text-subtle" />
            <div>
                <p class="text-sm font-medium text-content">Your preview is in its own window</p>
                <p class="mt-1 text-xs text-muted">Bring it back to fill this one, or keep the app beside your code on another screen.</p>
            </div>
            <!-- Inert while a window from before a reload is still reporting back: docking a window that hasn't
                 been re-adopted yet would be ruling on a window we can't see. It settles within the keeper's
                 grace either way. -->
            <Button size="small" :disabled="restoring" @click="dock()"> <Icon name="sign-in" />Bring it back here </Button>
        </div>
    </div>
</template>
