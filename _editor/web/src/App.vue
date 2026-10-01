<!-- Root shell: router outlet, the session runtime, and app-global overlays not owned by any route (sign-in gate, model picker). -->
<script setup lang="ts">
import HostModelPicker from "./features/chat/models/host/HostModelPicker.vue";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "./features/auth/useAuth";
import { HANDOFF_ROUTE } from "./features/auth/handoffSpent";
import { useSandbox } from "./features/sandbox/client/useSandbox";
import { startNotificationSources } from "./shell/notifications/notificationSources";
import { startRememberingSandboxes } from "./features/sandbox/recovery/rememberSandboxes";
import NotificationHost from "./shell/notifications/NotificationHost.vue";
import SignInWall from "./features/sandbox/gates/SignInWall.vue";
import WindowControls from "./shell/window/WindowControls.vue";
import WorkspaceRuntime from "./shell/WorkspaceRuntime.vue";
import LocalRuntime from "./local/LocalRuntime.vue";
import { localFace } from "./app/environments/local";

const { user } = useAuth();
const { activeSandboxId } = useSandbox();
const router = useRouter();
// A window on a folder of the user's own disk keeps only the file stream alive (local/LocalRuntime.vue).
const local = localFace() !== undefined;
// The desktop app's sign-in tab, in the reader's own browser, is a hand-off that exists to be closed: the workspace's
// runtime mounted there opened the sandbox's event stream, its queries and a chat panel in it, restored tabs included.
const route = useRoute();
const workspaceTab = computed(() => route.name !== HANDOFF_ROUTE);

/* Every standing fact and open question the app can float, declared once from the root (composables/notificationSources.ts). */
startNotificationSources();
// What this device remembers of the account's sandboxes, for when the platform cannot list them (features/sandbox/recovery).
startRememberingSandboxes();

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
    <WorkspaceRuntime v-if="user && activeSandboxId && !local && workspaceTab" />
    <LocalRuntime v-if="user && activeSandboxId && local" />
    <SignInWall />
    <HostModelPicker />
<!-- THE ONE LANE. -->
    <NotificationHost />
<!-- THE WINDOW'S OWN THREE BUTTONS, in the app's top row, inside the desktop app and nowhere else (shell/window/WindowControls.vue). -->
    <WindowControls />
</template>
