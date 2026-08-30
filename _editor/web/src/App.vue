<!-- Root shell: the router outlet, the signed-in session's runtime, and the app-global overlays, the
     browser→sandbox Google sign-in gate, and the shell's model picker when something outside the chat asks for
     one. The persistent workspace chrome (rail + docked columns) lives in the `/` layout route
     (shell/WorkspaceShell.vue), so it survives navigation between the shell's child pages. Both overlays are
     mounted here, not in the shell, because they fire outside it too: the sign-in gate is raised on /setup when
     the Google credential is pre-warmed there (see Setup.vue) before the shell ever mounts, and the model picker
     is raised by whichever extension view happens to be on screen (chat/hostModelPicker.ts).

     The runtime is here for the same reason and one more: the daemon stream and the poppable chat/terminal
     panels belong to the SESSION, not to a route (shell/WorkspaceRuntime.vue). Its condition is that session's
     definition: an account, and a sandbox for it to be pointed at. Signed out there is nothing to connect to,
     and with no sandbox selected there is nothing to connect to yet. -->
<script setup lang="ts">
import HostModelPicker from "./chat/HostModelPicker.vue";
import { watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "./composables/useAuth";
import { useSandbox } from "./composables/sandbox/useSandbox";
import { startNotificationSources } from "./composables/notificationSources";
import NotificationHost from "./shell/NotificationHost.vue";
import GoogleSigninGate from "./sandbox-gates/GoogleSigninGate.vue";
import WorkspaceRuntime from "./shell/WorkspaceRuntime.vue";

const { user } = useAuth();
const { activeSandboxId } = useSandbox();
const router = useRouter();

/* Every standing fact and open question the app can float, declared once from the root
 * (composables/notificationSources.ts). Here rather than in the runtime because two of them have to survive not
 * having a workspace at all: being on a stale build is as true of the login screen as of the workspace, and the
 * loopback offer is raised by a probe that runs on /setup and behind an invite link. The rest read module-scoped
 * state that answers with nothing until there is something to say. */
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
    <GoogleSigninGate />
    <HostModelPicker />
    <!-- THE ONE LANE. Every floating message this app raises is drawn here, in one bottom-right column
         (shell/NotificationHost.vue): a receipt for what just happened, a card for what is true right now, a card
         for what the user still owes an answer to. Above the route rather than inside the shell, and NOT behind a
         session — being on an old build is true of the login screen and the setup wizard exactly as much as it is
         of the workspace, and a first-time user stuck on a stale bundle is the one least able to work out why
         nothing behaves as documented. -->
    <NotificationHost />
</template>
