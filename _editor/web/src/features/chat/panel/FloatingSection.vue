<!-- Whole window for a popped-out panel (/floating/chat, /floating/terminal, /floating/preview). -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { closeOwnWindow } from "../../../app/environments/desktop";
import { useKeybindings } from "../../../shell/commands/useKeybindings";
import { useShellCommands } from "../../../shell/commands/useShellCommands";
import { claimFloating, type FloatingPanel } from "../../../shell/window/floating";
import { sendLinkToMainWindow } from "../../../shell/window/mainWindow";
import { markPreviewOpened } from "../../preview/previewSurface";
import { ACTIVE_KEY } from "../../sandbox/overview/activeSandbox";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { useLayout } from "../../../shell/window/useLayout";
import { chatFullSlot, previewSlot, terminalSlot } from "../../../shell/window/panelSlots";

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

// The window going away once its claim has let go. A browser ignores `window.close()` for a window the script didn't
// open (the desktop app closes its own by link instead), so the fallback is to become an ordinary window.
const close = (): void => {
    closeOwnWindow();
    void router.replace(`/`);
};

const handBack = claimFloating(panel, close);

// Closing the panel from inside its own window docks it — its x can't mean "leave an empty window".
if (panel === `terminal`) {
    watch(layout.terminalOpen, (open) => {
        if (!open) {
            handBack();
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
const dockRef = computed(() => (panel === `chat` ? chatFullSlot : panel === `terminal` ? terminalSlot : previewSlot));
onMounted(() => {
    dockRef.value.value = slot.value;
});
onUnmounted(() => {
    dockRef.value.value = null;
});
</script>

<template>
<!-- The chat panel styles itself with `grid-area: chat`, so its slot's parent must be a grid with that area; the other two fill a plain flex column. -->
    <div
        v-if="panel === `chat`"
        class="chat-floating-root grid h-screen w-screen overflow-hidden"
        style="grid-template-areas: &quot;chat&quot;; grid-template-columns: 1fr; grid-template-rows: 1fr"
    >
        <div ref="slot" class="contents"></div>
    </div>
    <div v-else class="flex h-screen w-screen flex-col overflow-hidden">
        <div ref="slot" class="contents"></div>
    </div>
</template>
