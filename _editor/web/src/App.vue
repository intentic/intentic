<!-- Root shell: router outlet, the session runtime, and app-global overlays not owned by any route (sign-in gate, model picker). -->
<script setup lang="ts">
import HostModelPicker from "./features/chat/models/host/HostModelPicker.vue";
import { watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "./features/auth/useAuth";
import { useSandbox } from "./features/sandbox/client/useSandbox";
import { startNotificationSources } from "./shell/notifications/notificationSources";
import NotificationHost from "./shell/notifications/NotificationHost.vue";
import SigninGate from "./features/sandbox/gates/SigninGate.vue";
import WindowControls from "./shell/window/WindowControls.vue";
import WorkspaceRuntime from "./shell/WorkspaceRuntime.vue";

const { user } = useAuth();
const { activeSandboxId } = useSandbox();
const router = useRouter();

/* Every standing fact and open question the app can float, declared once from the root (composables/notificationSources.ts). */
startNotificationSources();

// A confirmed platform 401, server-side expiry, or another tab signing out clears the shared user ref. The
// runtime above the route unmounts immediately; move the stale shell itself to login as the same global event.
watch(user, (current, previous) => {
    if (current === null && previous !== null) {
        void router.replace(`/login`);
    }
});
</script>

<template>
    <RouterView />
    <WorkspaceRuntime v-if="user && activeSandboxId" />
    <SigninGate />
    <HostModelPicker />
<!-- THE ONE LANE. -->
    <NotificationHost />
<!-- THE WINDOW'S OWN THREE BUTTONS, in the app's top row, inside the desktop app and nowhere else (shell/window/WindowControls.vue). -->
    <WindowControls />
</template>
