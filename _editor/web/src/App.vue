<!-- Root shell: router outlet, the session runtime, and app-global overlays not owned by any route (sign-in gate, model picker). -->
<script setup lang="ts">
import AiLiteracyNotice from "./features/sandbox/ai-literacy/AiLiteracyNotice.vue";
import HostModelPicker from "./features/chat/models/host/HostModelPicker.vue";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "./client/auth/useAuth";
import { HANDOFF_ROUTE } from "./features/auth/handoffSpent";
import { useSandbox } from "./client/sandbox/useSandbox";
import { startNotificationSources } from "./shell/notifications/notificationSources";
import { startRememberingSandboxes } from "./features/sandbox/recovery/rememberSandboxes";
import NotificationHost from "./workbench/notifications/NotificationHost.vue";
import SignInWall from "./features/sandbox/gates/SignInWall.vue";
import SignInDialog from "./features/auth/SignInDialog.vue";
import { askSignIn } from "./features/auth/signInDialog";
import { desktopWorkspace } from "./app/environments/desktopWorkspace";
import WindowControls from "./workbench/window/WindowControls.vue";
import WorkspaceRuntime from "./shell/WorkspaceRuntime.vue";
import LocalRuntime from "./local/LocalRuntime.vue";
import { localFace } from "./app/environments/local";

const { user, signingOut } = useAuth();
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

// The desktop app's workspace asks for a sign-in in a dialog over the view rather than on /login (features/auth/signInDialog.ts).
const signsInInPlace = desktopWorkspace();

// A confirmed platform 401, server-side expiry, or another tab signing out clears the shared user ref. The
// runtime above the route unmounts immediately; move the stale shell itself to login as the same global event. In the
// desktop app the view stays where it was, under the dialog asking for the sign-in again: the window has no address bar
// to get back to it by. A sign-out the reader asked for leaves by its own road (afterSignOut.ts), with nothing to ask.
watch(user, (current, previous) => {
    if (current !== null || previous === null) {
        return;
    }
    if (!signsInInPlace) {
        void router.replace(`/login`);
        return;
    }
    if (!signingOut()) {
        askSignIn(route.fullPath, `lapsed`);
    }
});
</script>

<template>
    <RouterView />
    <WorkspaceRuntime v-if="user && activeSandboxId && !local && workspaceTab" />
    <LocalRuntime v-if="user && activeSandboxId && local" />
    <SignInWall />
    <SignInDialog v-if="signsInInPlace" />
    <HostModelPicker />
    <AiLiteracyNotice v-if="user && activeSandboxId && !local && workspaceTab" />
<!-- THE ONE LANE. -->
    <NotificationHost />
<!-- THE WINDOW'S OWN THREE BUTTONS, in the app's top row, inside the desktop app and nowhere else (workbench/window/WindowControls.vue). -->
    <WindowControls />
</template>
