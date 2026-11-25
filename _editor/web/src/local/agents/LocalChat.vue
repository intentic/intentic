<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { computed, onMounted, onUnmounted } from "vue";
import ChatPanel from "../../features/chat/panel/ChatPanel.vue";
import ChatQuickBar from "../../features/chat/panel/ChatQuickBar.vue";
import { readComputerHarnesses } from "../../models/conversations/accounts/computerSignIn";
import { chatParked, chatTucked, toggleChatTucked } from "../../models/conversations/panel/chatPanelLayout";
import SidePanel from "../../shell/side/SidePanel.vue";
import { registerBuiltin } from "../../workbench/commands/builtinCommands";
import { chatBarSlot, chatSlot } from "../../workbench/window/panelSlots";
import { useFollowComputerRuns } from "./followRuns";

/* THE CHAT OF A FOLDER WINDOW, WHERE THIS COMPUTER RUNS AGENTS (2026-11-25): the sandbox shell's own right-hand column
   (shell/side/SidePanel.vue), at the right of every page of the window as it stands at the right of every page of a
   sandbox, the same width, the same edge to drag and the same strip to tuck it into, with the same quick bar over the
   page while it is tucked (ChatQuickBar.vue). Mounted by the shell only once the reader has turned agents on for this
   computer (LocalShell.vue): before that the Agents page is the one screen saying what that means, and no chat stands
   anywhere. Until 2026-11-25 the chat was the Agents page's own right side, beside a list of its own, and nothing about
   the window read like a sandbox's.

   What a sandbox window mounts above its router for the same column (shell/window/PoppablePanels.vue) is the chat, the
   terminal and the live browser, each able to move into a window of its own; a folder window has the chat alone, and no
   window to move it to. So its move is only between the column and the quick bar, the rule PoppablePanels keeps. */

// Offscreen, not display:none, as PoppablePanels parks its panels: a zero-size box would collapse what the chat measures.
const park = document.createElement(`div`);
park.style.cssText = `position:fixed;left:-20000px;top:0;width:900px;height:700px;overflow:hidden;visibility:hidden`;
document.body.append(park);
onUnmounted(() => park.remove());

// Tucked into its strip, the quick bar holds the composer alone over the page; otherwise the column; parked until either
// is published, so the panel is moved, never built again.
const chatTarget = computed(() => (chatParked.value ? chatBarSlot.value : null) ?? chatSlot.value ?? park);
const inBar = computed(() => chatBarSlot.value !== null && chatTarget.value === chatBarSlot.value);

// The fold, by keyboard as by its button, the sandbox shell's own command (shell/commands/useShellCommands.ts).
let commands: readonly Disposable[] = [];
onMounted(() => {
    commands = [
        registerBuiltin(`chat.toggleTucked`, toggleChatTucked, {
            title: () => (chatTucked.value ? t(`shell.useShellCommands.showChat`) : t(`shell.useShellCommands.tuckChat`)),
        }),
    ];
});
onUnmounted(() => {
    for (const command of commands) {
        command.dispose();
    }
    commands = [];
});

// A turn the sidecar starts by itself (words that waited behind a stopped turn) is followed off the roster, on whichever
// page the chat stands beside.
useFollowComputerRuns();

// Which coding agents this computer has, their sign-ins and their models: read once the chat stands, which is only after
// the reader has said yes, since the sidecar starts nothing, a sign-in included, before that.
onMounted(() => void readComputerHarnesses());
</script>

<template>
    <!-- The right-hand column, in the shell's `side` area: the chat, its edge and its strip. -->
    <SidePanel />
    <!-- The tucked chat's scratch pad, floating in the page's own cell, as in a sandbox's shell. -->
    <ChatQuickBar />
    <Teleport :to="chatTarget">
        <ChatPanel :bar="inBar" style="grid-area: chat" />
    </Teleport>
</template>
