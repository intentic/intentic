<script setup lang="ts">
import { computed, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useChatFloating } from "../../features/chat/panel/chatFloating";
import { globalTerminalSource, useTerminalPanel } from "../../features/terminal/useTerminalPanel";
import { useTerminalFloating } from "../../features/terminal/terminalFloating";
import { chatOnRail } from "../../features/chat/panel/chatPanelLayout";
import { previewOpened,PREVIEW_SIDE_VIEW } from "../../features/preview/previewSurface";
import { usePreviewFloating } from "../../features/preview/previewFloating";
import ChatPanel from "../../features/chat/panel/ChatPanel.vue";
import PreviewPanel from "../../features/preview/PreviewPanel.vue";
import TerminalPanel from "../../features/terminal/TerminalPanel.vue";
import { chatBarSlot, chatSlot, chatFullSlot, previewSlot, sidePreviewSlot, terminalSlot } from "./panelSlots";
import { tabsOfView } from "../side/sideTabs";

// The three poppable panels (chat, terminal, preview), mounted once per window, above the router. Each is
// teleported to wherever it belongs (its section, the side panel, a floating window's slot, or a parking stage) — a
// move, never a rebuild. Which window draws which is one read of `shows`: this window is the panel's floating window, or
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

// Full-window slot first; on the rail the column is never a fallback, only the quick bar and then the parking stage.
const chatTarget = computed(() => chatFullSlot.value ?? (chatOnRail.value ? (chatBarSlot.value ?? park) : (chatSlot.value ?? park)));
// Read off where it actually went, like every other presentation question here: the strip takes the composer alone.
// The side panel draws its own edge and seam around the chat, as it does around everything it holds.
const inBar = computed(() => chatTarget.value === chatBarSlot.value);
const terminalTarget = computed(() => terminalSlot.value ?? park);
// Its section, then its tab in the side panel, then parked, where the live iframe keeps its own state.
const previewTarget = computed(() => previewSlot.value ?? sidePreviewSlot.value ?? park);

// Only a dock lands a panel visible on its route home; one whose window merely went away returns without moving the reader.
chat.onDocked(() => {
    if (chatOnRail.value && router.currentRoute.value.name !== `chat`) {
        void router.push(`/chat`);
    }
});
// A preview with a tab in the side panel comes back to it, beside wherever the reader is.
preview.onDocked(() => {
    if (previewOpened.value && router.currentRoute.value.name !== `preview` && tabsOfView(PREVIEW_SIDE_VIEW).length === 0) {
        void router.push(`/preview`);
    }
});
</script>

<template>
    <!-- Grid area and border live on the panel, not the slot: the slot is `display: contents` and generates no box. -->
    <Teleport :to="chatTarget">
        <ChatPanel v-if="chat.shows.value" :bar="inBar" style="grid-area: chat" />
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
