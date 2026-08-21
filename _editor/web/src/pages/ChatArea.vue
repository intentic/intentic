<!-- FULL-SCREEN CHAT, the /chat area: the rail-docked chat's whole surface, desktop only.

     The panel itself is mounted once per page by shell/WorkspaceRuntime's PoppablePanels and TELEPORTED to
     whichever slot is published (shell/dockSlots.ts): this route publishes the full-window one. With the rail
     as the chat's home (useLayout.chatHome, claimed below), this area is the only place in the main window the
     chat appears at all: every other view leaves it parked behind the rail's Chat tile, never as a side
     column. Nothing chat-shaped is duplicated here, and a streaming turn survives every trip exactly as it
     survives popping out.

     The grid exists because the panel's own classes were written against the shell grid: it styles itself with
     `grid-area: chat`, so the slot's parent must BE a grid with that area or the panel gets no box.

     WHILE THE CHAT IS IN A WINDOW OF ITS OWN this area does not steal it: the panel is drawn by that window, so
     the grid stands empty and the notice below says where the chat is, with the one explicit way to recall it.
     Never an automatic recall: a URL that happens to be /chat must not close a window under the user. Every
     move of the panel is a button. -->
<script setup lang="ts">
import Button from "primevue/button";
import { onMounted, onUnmounted, useTemplateRef } from "vue";
import { useChatFloating } from "../composables/chat/chatFloating";
import { useLayout } from "../composables/useLayout";
import { chatFullDock } from "../shell/dockSlots";

const { floats, dock } = useChatFloating();

/* STANDING HERE IS CHOOSING THE RAIL AS THE CHAT'S HOME. Every control that leads here sets the home first,
 * but a bookmark or a hand-typed /chat arrives without one, and this area with the home still on `side` would
 * be a screen whose own tile is missing from the rail beside it. Claiming it in setup keeps the invariant (on
 * /chat ⇒ the rail is home ⇒ its tile is lit) whatever the door; a no-op through every ordinary one. */
useLayout().setChatHome(`rail`);

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
        <!-- Published even while another window holds the panel, so "Bring it back here" lands it in this slot
             the instant the window goes: no intermediate hop through the side column. -->
        <div class="grid h-full w-full" style="grid-template-areas: &quot;chat&quot;; grid-template-columns: 1fr; grid-template-rows: 1fr">
            <div ref="slot" class="contents"></div>
        </div>
        <div v-if="floats" class="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <Icon name="external-link" class="text-3xl text-subtle" />
            <div>
                <p class="text-sm font-medium text-content">Your chat is in its own window</p>
                <p class="mt-1 text-xs text-muted">Bring it back to fill this one, or keep using the floating window.</p>
            </div>
            <Button size="small" @click="dock()"> <Icon name="sign-in" />Bring it back here </Button>
        </div>
    </div>
</template>
