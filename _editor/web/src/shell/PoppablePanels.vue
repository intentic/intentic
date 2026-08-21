<script setup lang="ts">
import { computed, onUnmounted, watch, watchEffect } from "vue";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { globalTerminalSource, useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { useTerminalPopout } from "../composables/terminal/useTerminalPopout";
import { chatFullscreen, chatOnRail } from "../composables/chat/chatSurface";
import { markPreviewOpened, previewOpened } from "../composables/preview/previewSurface";
import { usePreviewPopout } from "../composables/preview/usePreviewPopout";
import ChatPanel from "../chat/ChatPanel.vue";
import PreviewPanel from "../preview/PreviewPanel.vue";
import TerminalPanel from "../pages/TerminalPanel.vue";
import { chatDock, chatFullDock, previewDock, terminalDock } from "./dockSlots";

/* THE THREE POPPABLE PANELS (the chat, the sandbox-global terminal and the app preview) each mounted exactly
 * once per page, here above the router rather than inside the workspace shell (dockSlots.ts has the why). One
 * instance whose live DOM is teleported to wherever the panel currently belongs: its pop-out window, the
 * shell's docked slot, or the parking stage below. A move is a move, never a rebuild, so a streaming turn, an
 * open picker and an attached xterm ride through navigation the way they already ride through popping out.
 *
 * WHAT THIS COMPONENT'S OWN LIFETIME MEANS. It owns the panels, so it is the one thing whose going away really
 * does orphan a floating window, and it now goes away only when the workspace itself does: a lost session
 * bounced to /login, the last sandbox deselected, the viewport crossing into the mobile shell (which has no
 * docked panel to come home to). Signing out is not on that list because it reloads the page outright: that
 * window is handled by its keeper, which closes a window no live page will answer for.
 *
 * So this is where each floating window learns whether it is still a view of the app: the holds below say "a
 * panel is being rendered into you right now", for exactly as long as it is (composables/usePopout.ts has the
 * contract, and why a window told anything less honest than this ends up frozen on its last frame). Saying it
 * as a HOLD rather than as a dock() on unmount is what lets a remount cross without casualties: the previous
 * shape decided the window's fate at the first frame of a teardown, and a teardown that turned out to be the
 * first half of a remount had already closed the user's floating chat, or latched a refusal that kept the panel
 * from ever floating again on that page. Nothing here decides anything now: it reports, and the window acts. */

const { restoring: chatRestoring, body: chatPopoutBody, holdWhile: holdChat } = useChatPopout();
const {
    poppedOut: terminalPoppedOut,
    restoring: terminalRestoring,
    body: terminalPopoutBody,
    dock: dockTerminal,
    holdWhile: holdTerminal,
} = useTerminalPopout();
const terminal = useTerminalPanel();
const { poppedOut: previewPoppedOut, restoring: previewRestoring, body: previewPopoutBody, holdWhile: holdPreview } = usePreviewPopout();

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

// The chat's three homes, in rank: its own window, the /chat area filling the main one, the docked column.
// The pop-out outranks the full-window slot so a URL restored to /chat can never steal a floating window the
// reload path is busy re-adopting: recalling it is the area's own explicit button (ChatArea.vue). And while
// the RAIL is the chat's home, the column is never a fallback: away from /chat the panel waits on the parking
// stage behind the rail's Chat tile, which is the whole meaning of that choice (chatSurface.ts).
const chatTarget = computed(() => chatPopoutBody.value ?? chatFullDock.value ?? (chatOnRail.value ? park : (chatDock.value ?? park)));
const terminalTarget = computed(() => terminalPopoutBody.value ?? terminalDock.value ?? park);
// The preview's two homes plus the stage: its window, the /preview area's slot, else parked, where a live
// iframe keeps the previewed app's own state (its route, a half-filled form) across every trip to the code.
const previewTarget = computed(() => previewPopoutBody.value ?? previewDock.value ?? park);

/* A PREVIEW WINDOW IS ITS OWN DOOR. The panel exists only once someone opened it (previewSurface.opened:
 * an iframe nobody asked to see would be requests into their app), and a window is proof someone did: one
 * re-adopted after a reload, or restored, marks the panel open so it mounts straight out there: otherwise a
 * fresh page would answer the returning window `waiting` forever. */
watchEffect(() => {
    if (previewPoppedOut.value || previewRestoring.value) {
        markPreviewOpened();
    }
});

// Closing the panel (its ×, Ctrl+`) while floating also retires the otherwise-empty pop-out window. A decision
// by the reader, so it is a dock and not merely a released hold: the window goes now rather than after a grace.
watch(terminal.open, (open) => {
    if (!open) {
        dockTerminal();
    }
});

// What each window is told about itself, in the same terms as the `v-if` below, because that condition IS
// whether the panel exists to be drawn. Held until this component's scope ends, which is the only honest
// account of "the app stopped rendering into you" available anywhere in the page.
holdChat(() => !chatRestoring.value);
holdTerminal(() => terminal.open.value && !terminalRestoring.value);
holdPreview(() => previewOpened.value && !previewRestoring.value);
</script>

<template>
    <!-- The grid area and the column's border ride on the PANEL rather than the slot: the slot generates no box
         (display: contents), so the panel itself is the shell grid's item. Held back entirely while a pop-out
         window from before a page reload is still coming back, so the panel mounts once, out there, instead of
         building itself in the collapsed column first. -->
    <!-- The left border is the seam against the workspace it docks beside (kept in the pop-out window too,
         where it has always drawn). Filling the /chat area it would double the rail's own right border, so it
         is the one place the seam comes off. -->
    <Teleport :to="chatTarget">
        <ChatPanel v-if="!chatRestoring" :class="{ 'border-l border-line': !chatFullscreen }" style="grid-area: chat" />
    </Teleport>
    <Teleport :to="terminalTarget">
        <TerminalPanel
            v-if="terminal.open.value && !terminalRestoring"
            :source="globalTerminalSource"
            storage-key="sandbox"
            :initial="terminal.requested.value"
            :surfaced="terminal.surfaced.value"
            :resizable="!terminalPoppedOut"
            @close="terminal.setOpen(false)"
        />
    </Teleport>
    <!-- The preview mounts only once someone has opened it (see the watch above), and then stays: parked, the
         iframe keeps the previewed app alive between looks. -->
    <Teleport :to="previewTarget">
        <PreviewPanel v-if="previewOpened && !previewRestoring" />
    </Teleport>
</template>
