<!-- FULL-SCREEN CHAT — the /chat area: a full-bleed dock slot for the one chat panel instance, desktop only.

     The panel itself is mounted once per page by shell/WorkspaceRuntime's PoppablePanels and TELEPORTED to
     whichever slot is published (shell/dockSlots.ts) — this route publishes the full-window one, which outranks
     the shell's docked column while it is on screen. So entering the area is the chat moving out of its side
     column into the whole workspace, and leaving it is the same move back: nothing chat-shaped is duplicated
     here, and a streaming turn survives the trip exactly as it survives popping out. The URL is the whole of
     the mode — no stored flag can disagree with it.

     The grid exists because the panel's own classes were written against the shell grid: it styles itself with
     `grid-area: chat`, so the slot's parent must BE a grid with that area or the panel gets no box (the local
     posture's LocalChat.vue makes the same accommodation, for the same reason).

     WHILE THE CHAT FLOATS IN ITS OWN WINDOW this area does not steal it: the pop-out outranks this slot, so the
     grid stands empty and the notice below says where the chat is, with the one explicit way to recall it. An
     automatic recall here would race the reload path — a surviving pop-out window is re-adopted on load, and a
     URL that happens to be /chat must not close it under the user. Every move of the panel is a button. -->
<script setup lang="ts">
import Button from "primevue/button";
import { onMounted, onUnmounted, useTemplateRef } from "vue";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { chatFullDock } from "../shell/dockSlots";

const { poppedOut, restoring, dock } = useChatPopout();

const slot = useTemplateRef(`slot`);
onMounted(() => {
    chatFullDock.value = slot.value;
});
onUnmounted(() => {
    chatFullDock.value = null;
});
</script>

<template>
    <div class="relative h-full w-full">
        <!-- Published even while the pop-out holds the panel, so "Bring it back here" lands the panel in this
             slot the instant the dock happens — no remount, no intermediate hop through the side column. -->
        <div class="grid h-full w-full" style="grid-template-areas: &quot;chat&quot;; grid-template-columns: 1fr; grid-template-rows: 1fr">
            <div ref="slot" class="contents"></div>
        </div>
        <div v-if="poppedOut || restoring" class="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <Icon name="external-link" class="text-3xl text-subtle" />
            <div>
                <p class="text-sm font-medium text-content">Your chat is in its own window</p>
                <p class="mt-1 text-xs text-muted">Bring it back to fill this one, or keep using the floating window.</p>
            </div>
            <!-- Inert while a window from before a reload is still reporting back: docking a window that hasn't
                 been re-adopted yet would be ruling on a window we can't see. It settles within the keeper's
                 grace either way. -->
            <Button size="small" :disabled="restoring" @click="dock()"> <Icon name="sign-in" />Bring it back here </Button>
        </div>
    </div>
</template>
