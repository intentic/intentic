<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useChatFloating } from "../composables/chat/chatFloating";
import { globalTerminalSource, useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { useTerminalFloating } from "../composables/terminal/terminalFloating";
import { chatOnRail, chatWide } from "../composables/chat/chatSurface";
import { previewOpened } from "../composables/preview/previewSurface";
import { usePreviewFloating } from "../composables/preview/previewFloating";
import ChatPanel from "../chat/ChatPanel.vue";
import PreviewPanel from "../preview/PreviewPanel.vue";
import TerminalPanel from "../pages/TerminalPanel.vue";
import { chatDock, chatFullDock, previewDock, terminalDock } from "./dockSlots";

/* THE THREE POPPABLE PANELS (the chat, the sandbox-global terminal and the app preview) each mounted exactly
 * once per window, here above the router rather than inside the workspace shell (dockSlots.ts has the why). One
 * instance whose live DOM is teleported to wherever the panel currently belongs in THIS window: the shell's
 * docked slot, a full-window area, the floating window's one big slot, or the parking stage below. A move is a
 * move, never a rebuild, so a streaming turn, an open picker and an attached xterm ride through navigation.
 *
 * WHICH WINDOW DRAWS WHICH PANEL is one reading, `shows` (composables/floating.ts): this window is the panel's
 * floating window, or nobody else is floating it. That is the whole of the arrangement — there is no ownership
 * to resolve, no adoption, no liveness handshake, and no branch anywhere on "popped out or not". A window that
 * loses the panel unmounts it; a window that gains it mounts it and the daemon hands the state straight back
 * (the chat re-attaches its run by cursor, tmux redraws, the preview reloads).
 *
 * This component's own lifetime no longer decides anything about any window. It renders what it shows; a
 * floating window answers for itself. */

const chat = useChatFloating();
const terminalFloat = useTerminalFloating();
const terminal = useTerminalPanel();
const preview = usePreviewFloating();
const router = useRouter();

/* THE PARKING STAGE, where a docked panel waits out a route that has no shell to dock into. Offscreen rather
 * than `display: none`, because a panel with no box is a panel whose every measurement is zero: the terminal's
 * fit would send a 0×0 grid to the PTY on the way out and re-derive it on the way back, and the transcript's
 * scroll anchor would resolve against nothing. A stage with real dimensions keeps every observer reading
 * numbers it can act on, and being parked offscreen (rather than merely invisible) keeps it out of the way of
 * hit-testing and the tab order. */
const park = document.createElement(`div`);
park.style.cssText = `position:fixed;left:-20000px;top:0;width:900px;height:700px;overflow:hidden;visibility:hidden`;
document.body.append(park);
onUnmounted(() => park.remove());

// The chat's homes in this window, in rank: a full-window slot (the /chat area, or a floating window's whole
// canvas — both publish the same slot), else the docked column. And while the RAIL is the chat's home, the
// column is never a fallback: away from /chat the panel waits on the parking stage behind the rail's Chat tile,
// which is the whole meaning of that choice (chatSurface.ts).
const chatTarget = computed(() => chatFullDock.value ?? (chatOnRail.value ? park : (chatDock.value ?? park)));
const terminalTarget = computed(() => terminalDock.value ?? park);
// The preview has no side-column slot: it fills its area, fills its window, or waits parked, where a live
// iframe keeps the previewed app's own state (its route, a half-filled form) across every trip to the code.
const previewTarget = computed(() => previewDock.value ?? park);

/* A PANEL COMING BACK LANDS SOMEWHERE THE READER CAN SEE, in every window, whatever door the dock came
 * through: the floating window's own ×, another window's button, F9, the palette. This is the one rule that
 * used to be spread across the toggles, which is exactly how the window's × came to be the door that skipped
 * it: press it with the rail as the chat's home and the panel docked to the parking stage behind a tile, and
 * "I closed the window and my chat didn't come back" is that, nothing else.
 *
 * Only for the two panels whose home is a ROUTE. The terminal docks into the shell below the workspace, so it
 * is already on screen wherever the reader stands. */
watch(chat.floats, (floats) => {
    if (!floats && chatOnRail.value && router.currentRoute.value.name !== `chat`) {
        void router.push(`/chat`);
    }
});
watch(preview.floats, (floats) => {
    if (!floats && previewOpened.value && router.currentRoute.value.name !== `preview`) {
        void router.push(`/preview`);
    }
});
</script>

<template>
    <!-- The grid area and the column's border ride on the PANEL rather than the slot: the slot generates no box
         (display: contents), so the panel itself is the shell grid's item. -->
    <!-- The left border is the seam against the workspace it docks beside, so it belongs to the DOCKED column
         alone: filling a whole window or the /chat area it would double the rail's own right border. `chatWide`
         is exactly that distinction (chatSurface.ts). -->
    <Teleport :to="chatTarget">
        <ChatPanel v-if="chat.shows.value" :class="{ 'border-l border-line': !chatWide }" style="grid-area: chat" />
    </Teleport>
    <Teleport :to="terminalTarget">
        <TerminalPanel
            v-if="terminal.open.value && terminalFloat.shows.value"
            :source="globalTerminalSource"
            storage-key="sandbox"
            :initial="terminal.requested.value"
            :surfaced="terminal.surfaced.value"
            :resizable="!terminalFloat.floats.value"
            @close="terminal.setOpen(false)"
        />
    </Teleport>
    <!-- The preview mounts only once someone has opened it (previewSurface.opened), and then stays: parked, the
         iframe keeps the previewed app alive between looks. -->
    <Teleport :to="previewTarget">
        <PreviewPanel v-if="previewOpened && preview.shows.value" />
    </Teleport>
</template>
