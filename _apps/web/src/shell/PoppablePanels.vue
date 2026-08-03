<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { globalTerminalSource, useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { useTerminalPopout } from "../composables/terminal/useTerminalPopout";
import ChatPanel from "../chat/ChatPanel.vue";
import TerminalPanel from "../pages/TerminalPanel.vue";
import { chatDock, terminalDock } from "./dockSlots";

/* THE TWO POPPABLE PANELS — the chat and the sandbox-global terminal — each mounted exactly once per page, here
 * above the router rather than inside the workspace shell (dockSlots.ts has the why). One instance whose live
 * DOM is teleported to wherever the panel currently belongs: its pop-out window, the shell's docked slot, or
 * the parking stage below. A move is a move, never a rebuild, so a streaming turn, an open picker and an
 * attached xterm ride through navigation the way they already ride through popping out.
 *
 * WHAT THIS COMPONENT'S OWN LIFETIME MEANS. It owns the panels, so it is the one thing whose going away really
 * does orphan a floating window — and it now goes away only when the workspace itself does: a lost session
 * bounced to /login, the last sandbox deselected, the viewport crossing into the mobile shell (which has no
 * docked panel to come home to). Docking on unmount is therefore still right; it is just no longer something an
 * ordinary navigation triggers. Signing out is not on that list because it reloads the page outright — that
 * window is handled by its keeper, which closes a window no live page will answer for. */

const { restoring: chatRestoring, body: chatPopoutBody, dock: dockChat } = useChatPopout();
const { poppedOut: terminalPoppedOut, restoring: terminalRestoring, body: terminalPopoutBody, dock: dockTerminal } = useTerminalPopout();
const terminal = useTerminalPanel();

/* THE PARKING STAGE — where a docked panel waits out a route that has no shell to dock into. Offscreen rather
 * than `display: none`, because a panel with no box is a panel whose every measurement is zero: the terminal's
 * fit would send a 0×0 grid to the PTY on the way out and re-derive it on the way back, and the transcript's
 * scroll anchor would resolve against nothing. A stage with real dimensions keeps every observer reading
 * numbers it can act on, and being parked offscreen (rather than merely invisible) keeps it out of the way of
 * hit-testing and the tab order. */
const park = document.createElement(`div`);
park.style.cssText = `position:fixed;left:-20000px;top:0;width:900px;height:700px;overflow:hidden;visibility:hidden`;
document.body.append(park);
onUnmounted(() => park.remove());

const chatTarget = computed(() => chatPopoutBody.value ?? chatDock.value ?? park);
const terminalTarget = computed(() => terminalPopoutBody.value ?? terminalDock.value ?? park);

// Closing the panel (its ×, Ctrl+`) while floating also retires the otherwise-empty pop-out window.
watch(terminal.open, (open) => {
    if (!open) {
        dockTerminal();
    }
});

onUnmounted(() => {
    // Nothing can drive a floating window once the panel behind it is gone — see the three ways that happens
    // above. The keeper out there would close it on its own eventually; this is the same decision, taken at
    // the moment it becomes true instead of twelve seconds later.
    dockChat();
    dockTerminal();
});
</script>

<template>
    <!-- The grid area and the column's border ride on the PANEL rather than the slot: the slot generates no box
         (display: contents), so the panel itself is the shell grid's item. Held back entirely while a pop-out
         window from before a page reload is still coming back, so the panel mounts once, out there, instead of
         building itself in the collapsed column first. -->
    <Teleport :to="chatTarget">
        <ChatPanel v-if="!chatRestoring" class="border-l border-line" style="grid-area: chat" />
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
</template>
