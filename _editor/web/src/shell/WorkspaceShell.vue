<script setup lang="ts">
import { loadChunk, useDevice } from "@intentic/ui";
import { defineAsyncComponent, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { watchAgentsScope } from "../features/agents/board/agentsTile";
import { watchDeviceReturns } from "../features/sandbox/devices/useDeviceReturns";
import { useExtensionHost } from "../extension-host/useExtensionHost";
import { useMainWindow } from "../workbench/window/mainWindow";
import { openInWorkspace, openWorkspaceRef } from "../features/workspace/files/refs/openFileRef";
import { openPreviewBeside } from "../features/preview/previewSurface";
import { revealSideView } from "../workbench/side/sideViews";
import { prefetchViewsAtIdle } from "../router/prefetch";
import { useChat } from "../features/chat/run/useChat";
import { mobileChatPath } from "../lib/routes/tabRoots";
import { useGuestFence } from "./guestFence";

// Persistent post-login chrome, split by form factor: ShellDesktop (rail, side panel, terminal) under a
// pointer, ShellMobile (tab bar, full-screen views) below 768px. State lives in module composables, so
// the breakpoint swap doesn't restart it; liveness and the panels mount above the router (WorkspaceRuntime.vue).

const ShellDesktop = defineAsyncComponent(() => loadChunk(() => import("./ShellDesktop.vue")));
const ShellMobile = defineAsyncComponent(() => loadChunk(() => import("./ShellMobile.vue")));

const { mobile } = useDevice();
// Boot installed third-party extensions once the sandbox is reachable (idempotent across shell remounts).
useExtensionHost();
// A guest is kept to the screens the daemon answers it on.
useGuestFence();
// Keeps other sandboxes live while the board's scope is wide; shared so both chromes need only one poll.
watchAgentsScope();
// Answers an agent update's wait once the machine is read back on its new agent, whichever screen is open by then.
watchDeviceReturns();
// Pulls every view's chunk in the background once the shell is up (idempotent); see router/prefetch.ts.
onMounted(prefetchViewsAtIdle);
const router = useRouter();
const route = useRoute();

// Runs an errand a popped-out panel can't: opening a file, showing something beside, or taking a route. Announced only
// from here, since only a mounted shell can promise there's somewhere to put it (mainWindow.ts).
useMainWindow((errand) => {
    if (errand.kind === `file`) {
        void (errand.home === true ? openInWorkspace : openWorkspaceRef)(errand.path, errand.line, errand.scope);
    } else if (errand.kind === `preview`) {
        openPreviewBeside(router, errand.target);
    } else if (errand.kind === `side`) {
        revealSideView(errand.view, errand.input, { keep: errand.keep });
    } else {
        void router.push(errand.path);
    }
});

// Route guards only fire on navigation, not a live resize, so growing past the breakpoint on a
// mobile-only page (menu, terminal) bounces to the workspace; shrinking off full-screen chat lands on the same
// conversation's phone screen, as the /chat guard would have.
watch(mobile, (isMobile) => {
    if (!isMobile && [`menu`, `terminal`].includes(String(route.name))) {
        void router.push(`/workspace`);
    }
    if (isMobile && route.name === `chat`) {
        void router.replace(mobileChatPath(useChat().active.value.conversationId));
    }
});

// A dead sandbox no longer bounces the shell to /setup, which now only creates a new one.
// SandboxSwitcher and the liveness probe handle switching or adding one instead.
</script>

<template>
    <ShellMobile v-if="mobile" />
    <ShellDesktop v-else />
</template>
