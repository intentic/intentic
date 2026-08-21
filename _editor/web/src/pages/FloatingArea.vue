<!-- A FLOATING PANEL'S WHOLE WINDOW: /floating/chat, /floating/terminal, /floating/preview.

     This is an ordinary window of the app that happens to show one panel and no chrome. It boots its own copy
     of everything — auth, the sandbox connection, the panel's state — which is the entire point:
     composables/floating.ts explains what the shape before this one cost (a window painted from another
     window's realm, bound to its opener, needing a liveness protocol to tell a live panel from a photograph of
     one). Nothing renders into this window from outside, so nothing can leave it stale.

     WHAT THIS FILE ACTUALLY DOES is publish the panel's dock slot at full-window size and claim the panel for
     this window. The panel itself is mounted once per page by shell/PoppablePanels, exactly as it is in the main
     window, and teleported into the slot below (shell/dockSlots.ts). There is no second hosting path: the
     floating window is a window with one very large slot in it.

     The claim is a heartbeat. Every other window collapses this panel's place while it beats, and writes the
     window off a couple of seconds after it stops — a dock, a close, a crash and a killed window all arrive as
     the same silence, which is why there is no state the app can be stuck in. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useKeybindings } from "../composables/commands/useKeybindings";
import { useShellCommands } from "../composables/commands/useShellCommands";
import { claimFloating, type FloatingPanel } from "../composables/floating";
import { markPreviewOpened } from "../composables/preview/previewSurface";
import { ACTIVE_KEY } from "../composables/sandbox/activeSandbox";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useLayout } from "../composables/useLayout";
import { chatFullDock, previewDock, terminalDock } from "../shell/dockSlots";

const route = useRoute();
const router = useRouter();
const layout = useLayout();

// The route's regex admits only these three, so this is a read rather than a validation.
const panel = route.params[`panel`] as FloatingPanel;

const TITLES: Record<FloatingPanel, string> = {
    chat: `Intentic · Chat`,
    terminal: `Intentic · Terminal`,
    preview: `Intentic · Preview`,
};
document.title = TITLES[panel];

/* MAKING THE PANEL EXIST. Two of the three are conditional surfaces in the main window — the terminal is open
 * or closed, the preview has been looked at or never opened — and standing in this window IS the ask. Without
 * it a floating window would publish a slot that nothing ever mounts into, which is the empty-rectangle failure
 * the old shape needed a veil for. */
if (panel === `terminal`) {
    layout.setTerminalOpen(true);
}
if (panel === `preview`) {
    markPreviewOpened();
}

/* THE WINDOW GOING AWAY, asked for from anywhere: this window's own control, another window's Dock press, F9 in
 * either. Only this realm can try, and only this realm can tell that it was refused: `window.close()` is
 * ignored for a window the script did not open (a bookmark, a restored session), so the fallback is to stop
 * being a floating window and become an ordinary one. Either way the claim is released and every other window
 * takes the panel back. */
const dock = (): void => {
    window.close();
    void router.replace(`/`);
};

claimFloating(panel, dock);

/* Closing the panel from inside its own window closes the WINDOW: out here the panel is all there is, so its ×
 * cannot mean "leave an empty window behind". Only the terminal has such a control. */
if (panel === `terminal`) {
    watch(layout.terminalOpen, (open) => {
        if (!open) {
            dock();
        }
    });
}

/* FOLLOWING THE WORKSPACE. Which sandbox the app is pointed at is one localStorage fact for the whole origin,
 * and `storage` is the browser's own notification that another window changed it. A floating panel is a view of
 * ONE workspace's chat / terminal / preview, so a switch in the main window has to move this window too;
 * leaving it on the old sandbox would be the exact divergence this whole design deletes. */
const followSandbox = (event: StorageEvent): void => {
    if (event.key === ACTIVE_KEY && event.newValue !== null && event.newValue !== useSandbox().activeSandboxId.value) {
        useSandbox().select(event.newValue);
    }
};
onMounted(() => window.addEventListener(`storage`, followSandbox));
onUnmounted(() => window.removeEventListener(`storage`, followSandbox));

/* THE PALETTE'S COMMANDS AND THE SHORTCUT DISPATCHER, which the desktop shell installs for its own window and
 * this window therefore has to install for itself: F9 in the floating chat is the fastest way to dock it, and a
 * window where the shortcut did nothing would send the reader hunting for a button. Mutually exclusive with the
 * shell by routing (this route is not one of its children), so nothing double-registers. */
useShellCommands();
useKeybindings();

const slot = useTemplateRef(`slot`);
const dockRef = computed(() => (panel === `chat` ? chatFullDock : panel === `terminal` ? terminalDock : previewDock));
onMounted(() => {
    dockRef.value.value = slot.value;
});
onUnmounted(() => {
    dockRef.value.value = null;
});
</script>

<template>
    <!-- The chat panel styles itself with `grid-area: chat` (it was written against the shell grid), so its
         slot's parent has to BE a grid with that area or the panel gets no box. The other two fill a plain
         flex column. -->
    <div
        v-if="panel === `chat`"
        class="grid h-screen w-screen overflow-hidden"
        style="grid-template-areas: &quot;chat&quot;; grid-template-columns: 1fr; grid-template-rows: 1fr"
    >
        <div ref="slot" class="contents"></div>
    </div>
    <div v-else class="flex h-screen w-screen flex-col overflow-hidden">
        <div ref="slot" class="contents"></div>
    </div>
</template>
