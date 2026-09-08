<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { defineAsyncComponent, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { watchAgentsScope } from "../features/agents/board/agentsTile";
import { useExtensionHost } from "../extension-host/useExtensionHost";
import { useMainWindow } from "./window/mainWindow";
import { openWorkspaceRef } from "../features/workspace/files/openFileRef";
import { prefetchViewsAtIdle } from "../router/prefetch";

// Persistent post-login chrome, split by form factor: ShellDesktop (rail, chat, terminal) under a
// pointer, ShellMobile (tab bar, full-screen views) below 768px. State lives in module composables, so
// the breakpoint swap doesn't restart it; liveness and the panels mount above the router (WorkspaceRuntime.vue).

const ShellDesktop = defineAsyncComponent(() => import("./ShellDesktop.vue"));
const ShellMobile = defineAsyncComponent(() => import("./ShellMobile.vue"));

const { mobile } = useDevice();
// Boot installed third-party extensions once the sandbox is reachable (idempotent across shell remounts).
useExtensionHost();
// Keeps other sandboxes live while the board's scope is wide; shared so both chromes need only one poll.
watchAgentsScope();
// Pulls every view's chunk in the background once the shell is up (idempotent); see router/prefetch.ts.
onMounted(prefetchViewsAtIdle);
const router = useRouter();
const route = useRoute();

// Runs an errand a popped-out panel can't: opening a file or taking a route. Announced only from here,
// since only a mounted shell can promise there's somewhere to put it (mainWindow.ts).
useMainWindow((errand) => {
    if (errand.kind === `file`) {
        void openWorkspaceRef(errand.path, errand.line, errand.scope);
    } else {
        void router.push(errand.path);
    }
});

// Route guards only fire on navigation, not a live resize, so growing past the breakpoint on a
// mobile-only page (menu, terminal) bounces to the workspace; shrinking off full-screen chat lands on agents.
watch(mobile, (isMobile) => {
    if (!isMobile && [`menu`, `terminal`].includes(String(route.name))) {
        void router.push(`/workspace`);
    }
    if (isMobile && route.name === `chat`) {
        void router.push(`/agents`);
    }
});

// A dead sandbox no longer bounces the shell to /setup, which now only creates a new one.
// SandboxSwitcher and the liveness probe handle switching or adding one instead.
</script>

<template>
    <ShellMobile v-if="mobile" />
    <ShellDesktop v-else />
</template>
