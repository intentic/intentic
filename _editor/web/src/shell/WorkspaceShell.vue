<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { defineAsyncComponent, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { watchAgentsScope } from "../composables/agents/agentsTile";
import { useExtensionHost } from "../extension-host/useExtensionHost";
import { useMainWindow } from "../composables/mainWindow";
import { openWorkspaceRef } from "../composables/workspace/openFileRef";
import { prefetchViewsAtIdle } from "../router/prefetch";

/* The persistent post-login CHROME, split by form factor: ShellDesktop (rail + docked chat column + terminal
 * panel) under a pointer, ShellMobile (bottom tab bar + full-screen views) under 768px. Only the
 * device-independent part lives here, so crossing the breakpoint (rotation, split-screen) swaps chrome without
 * restarting any of it; view state itself survives in the module-singleton composables. Async components keep
 * the unused chrome out of the initial chunk.
 *
 * What used to live here and no longer does: the sandbox's liveness stream, presence, and the chat/terminal
 * panels themselves. Those belong to the SESSION rather than to this route, and holding them here is what let
 * a step outside the shell (/setup, an invite link) close a floating chat window and drop its connection.
 * They are mounted above the router now (shell/WorkspaceRuntime.vue); this route supplies the places the
 * panels dock into (shell/dockSlots.ts) and nothing more. */

const ShellDesktop = defineAsyncComponent(() => import("./ShellDesktop.vue"));
const ShellMobile = defineAsyncComponent(() => import("./ShellMobile.vue"));

const { mobile } = useDevice();
// Boot installed third-party extensions once the sandbox is reachable (idempotent across shell remounts).
useExtensionHost();
/* Keep the other sandboxes' fleets live while the board's scope is wide, because from here on the Agents
 * badge is about them too (composables/agents/agentsTile.ts). Device-independent by nature, both chromes draw
 * that badge, so one subscription here rather than one per shell: the rail and the tab bar would otherwise
 * start and stop the same poll as the viewport crossed the breakpoint. */
watchAgentsScope();
// Pull every view's chunk in the background once the shell is up (idempotent; see router/prefetch.ts): the
// half of "navigation never waits" that makes the outlines a cold-network-only sight.
onMounted(prefetchViewsAtIdle);
const router = useRouter();
const route = useRoute();

/* WHERE A LINK PRESSED IN A POPPED-OUT PANEL LANDS. This window has the app in it, so it says so while
 * something is floating and does the errands that window cannot: opening a file it was asked about, or taking
 * the route a tool card offered. Announced from HERE rather than from the app's root because the promise is
 * exactly "there is a shell in this window": a window on /login or /setup has nowhere to put a file, and a
 * floating window that believed it did would hand its errand into a void (composables/mainWindow.ts). */
useMainWindow((errand) => {
    if (errand.kind === `file`) {
        void openWorkspaceRef(errand.path, errand.line, errand.scope);
    } else {
        void router.push(errand.path);
    }
});

// The form-factor route guards only fire on navigation, not on a live resize. If the viewport grows past the
// mobile breakpoint while parked on a mobile-only page (menu, terminal), the desktop shell would render it in
// its workspace column: bounce to the workspace so the desktop chrome is coherent. And the mirror image:
// shrinking into the mobile shell while on full-screen chat lands on the fleet, where mobile's chat lives.
watch(mobile, (isMobile) => {
    if (!isMobile && [`menu`, `terminal`].includes(String(route.name))) {
        void router.push(`/workspace`);
    }
    if (isMobile && route.name === `chat`) {
        void router.push(`/agents`);
    }
});

// A dead active sandbox no longer bounces the whole shell to /setup (that now creates a NEW sandbox). The
// liveness probe keeps `reachable` live and the rail's SandboxSwitcher lets the user switch or add one.
</script>

<template>
    <ShellMobile v-if="mobile" />
    <ShellDesktop v-else />
</template>
