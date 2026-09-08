<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useChatFloating } from "../../features/chat/panel/chatFloating";
import { globalTerminalSource, useTerminalPanel } from "../../features/terminal/useTerminalPanel";
import { useTerminalFloating } from "../../features/terminal/terminalFloating";
import { chatOnRail, chatWide } from "../../features/chat/panel/chatPanelLayout";
import { previewOpened } from "../../features/preview/previewSurface";
import { usePreviewFloating } from "../../features/preview/previewFloating";
import ChatPanel from "../../features/chat/panel/ChatPanel.vue";
import PreviewPanel from "../../features/preview/PreviewPanel.vue";
import TerminalPanel from "../../features/terminal/TerminalPanel.vue";
import { chatDock, chatFullDock, previewDock, terminalDock } from "./dockSlots";

// The three poppable panels (chat, terminal, preview), mounted once per window, above the router. Each is
// teleported to wherever it belongs (docked slot, full area, floating window's slot, or a parking stage) — a move,
// never a rebuild. Which window draws which is one read of `shows`: this window is the panel's floating window, or
// nobody is.

const chat = useChatFloating();
const terminalFloat = useTerminalFloating();
const terminal = useTerminalPanel();
const preview = usePreviewFloating();
const router = useRouter();

// Offscreen, not display:none: a zero-size box would zero the terminal's PTY grid and scroll anchor.
const park = document.createElement(`div`);
park.style.cssText = `position:fixed;left:-20000px;top:0;width:900px;height:700px;overflow:hidden;visibility:hidden`;
document.body.append(park);
onUnmounted(() => park.remove());

// Full-window slot first; on the rail the column is never a fallback, only the parking stage.
const chatTarget = computed(() => chatFullDock.value ?? (chatOnRail.value ? park : (chatDock.value ?? park)));
const terminalTarget = computed(() => terminalDock.value ?? park);
// No side-column slot: fills its area or window, or waits parked, where the live iframe keeps its own state.
const previewTarget = computed(() => previewDock.value ?? park);

// Redirects to the panel's route home on close, so it lands visible; only panels whose home is a route.
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
    <!-- Grid area and border live on the panel, not the slot: the slot is `display: contents` and generates no box. -->
    <!-- Border belongs to the docked column alone; a full window or /chat would double the rail's own border. -->
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
    <!-- Mounts once opened, then stays; parked, the iframe keeps the previewed app alive between looks. -->
    <Teleport :to="previewTarget">
        <PreviewPanel v-if="previewOpened && preview.shows.value" />
    </Teleport>
</template>
