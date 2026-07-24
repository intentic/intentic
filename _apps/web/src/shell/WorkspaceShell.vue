<script setup lang="ts">
import { useDevice } from "@intentic-app/ui";
import { defineAsyncComponent, onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { useChat } from "../composables/chat/useChat";
import { reportIdle, reportSessionId, reportView } from "../composables/usePresence";
import { useSandboxLiveness } from "../composables/sandbox/useSandboxLiveness";
import { useExtensionHost } from "../extension-host/useExtensionHost";

/* The persistent post-login shell, split by form factor: ShellDesktop (rail + chat column + terminal panel)
 * under a pointer, ShellMobile (bottom tab bar + full-screen views) under 768px. Only the device-independent
 * lifecycle lives here — sandbox liveness, presence reporting, the plan preload — so crossing the breakpoint
 * (rotation, split-screen) swaps chrome without restarting any of it; view state itself survives in the
 * module-singleton composables. Async components keep the unused chrome out of the initial chunk. */

const ShellDesktop = defineAsyncComponent(() => import("./ShellDesktop.vue"));
const ShellMobile = defineAsyncComponent(() => import("./ShellMobile.vue"));

const { mobile } = useDevice();
const { refreshPlan } = useAuth();
const liveness = useSandboxLiveness();
// Boot installed third-party extensions once the sandbox is reachable (idempotent across shell remounts).
useExtensionHost();
const router = useRouter();
const route = useRoute();

// The route guards on chat/menu/terminal only fire on navigation, not on a live resize. If the viewport grows
// past the mobile breakpoint while parked on one of those mobile-only pages, the desktop shell would render it
// in its workspace column — bounce to the workspace so the desktop chrome is coherent.
watch(mobile, (isMobile) => {
    if (!isMobile && [`chat`, `menu`, `terminal`].includes(String(route.name))) {
        void router.push(`/workspace`);
    }
});

// Presence reporting: what this tab is looking at, pushed to the daemon so other members see it live.
// Shell-scoped on purpose — presence only exists while the shell holds the liveness stream open (started/
// stopped in the same mount/unmount below), so these watches share exactly that lifetime.
watch(
    () => route.name,
    (name) =>
        reportView(
            name === `extension` ? `ext:${String(route.params[`ext`])}/${String(route.params[`key`])}` : typeof name === `string` ? name : undefined,
        ),
    { immediate: true },
);
const { active: activeConversation } = useChat();
watch(
    () => activeConversation.value.session.value?.id,
    (sessionId) => reportSessionId(sessionId),
    { immediate: true },
);
const onVisibility = (): void => reportIdle(document.hidden);

// The shell only renders for a connected sandbox; from here on a single long-lived SSE stream to the daemon
// keeps `reachable` live, so a killed sandbox is detected the moment the stream breaks.
onMounted(() => {
    liveness.start();
    document.addEventListener(`visibilitychange`, onVisibility);
    onVisibility();
    // Load the account's plan/entitlements once for the whole app, so plan-gated actions (the sandbox
    // switcher's "Add sandbox" preflight) upsell before navigating instead of after a 402 on /setup.
    void refreshPlan();
});
onUnmounted(() => {
    liveness.stop();
    document.removeEventListener(`visibilitychange`, onVisibility);
});
// A dead active sandbox no longer bounces the whole shell to /setup (that now creates a NEW sandbox). The
// liveness probe keeps `reachable` live and the rail's SandboxSwitcher lets the user switch or add one.
</script>

<template>
    <ShellMobile v-if="mobile" />
    <ShellDesktop v-else />
</template>
