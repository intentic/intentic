<!--
    Whole window for a popped-out panel (/floating/chat, /floating/terminal, /floating/preview): boots its own auth and sandbox connection rather
    than sharing the opener's. Publishes the panel's dock slot at full-window size and claims it with a heartbeat; losing the heartbeat frees the
    claim, so no window can get stuck holding it.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useKeybindings } from "../../../shell/commands/useKeybindings";
import { useShellCommands } from "../../../shell/commands/useShellCommands";
import { claimFloating, type FloatingPanel } from "../../../shell/window/floating";
import { sendLinkToMainWindow } from "../../../shell/window/mainWindow";
import { markPreviewOpened } from "../../preview/previewSurface";
import { ACTIVE_KEY } from "../../sandbox/overview/activeSandbox";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { useLayout } from "../../../shell/window/useLayout";
import { chatFullDock, previewDock, terminalDock } from "../../../shell/window/dockSlots";

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

// Two of the three are conditional surfaces in the main window (terminal open/closed, preview looked-at-or-not);
// standing in this window IS the ask, or a floating window would publish a slot nothing ever mounts into.
if (panel === `terminal`) {
    layout.setTerminalOpen(true);
}
if (panel === `preview`) {
    markPreviewOpened();
}

// The window going away, asked for from anywhere (this window, another window's Dock press, F9). `window.close()`
// is ignored for a window the script didn't open, so the fallback is to stop being floating and become an
// ordinary window; either way the claim releases.
const dock = (): void => {
    window.close();
    void router.replace(`/`);
};

claimFloating(panel, dock);

// Closing the panel from inside its own window closes the window — its x can't mean "leave an empty window".
if (panel === `terminal`) {
    watch(layout.terminalOpen, (open) => {
        if (!open) {
            dock();
        }
    });
}

// Links lead out of here, not through here: a followed link would replace the panel on this window with an app
// view. Every in-app link goes to the main window instead (opening one if none exists). On the document, in
// capture, so it beats RouterLink's own click handler.
onMounted(() => document.addEventListener(`click`, sendLinkToMainWindow, true));
onUnmounted(() => document.removeEventListener(`click`, sendLinkToMainWindow, true));

// Following the workspace: which sandbox is active is one localStorage fact per origin, and `storage` is the
// browser's cross-window notification. A floating panel must follow the main window's switch, or it would diverge.
const followSandbox = (event: StorageEvent): void => {
    if (event.key === ACTIVE_KEY && event.newValue !== null && event.newValue !== useSandbox().activeSandboxId.value) {
        useSandbox().select(event.newValue);
    }
};
onMounted(() => window.addEventListener(`storage`, followSandbox));
onUnmounted(() => window.removeEventListener(`storage`, followSandbox));

// The palette and shortcut dispatcher, installed here since the desktop shell only installs them for its own
// window: F9 must still dock a floating chat. Mutually exclusive with the shell by route, so nothing
// double-registers.
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
    <!--
        The chat panel styles itself with `grid-area: chat`, so its slot's parent must be a grid with that area; the
        other two fill a plain flex column.
    -->
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
