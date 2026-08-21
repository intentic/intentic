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
import GoogleSigninGate from "./sandbox-gates/GoogleSigninGate.vue";
import WorkspaceRuntime from "./shell/WorkspaceRuntime.vue";

const { user } = useAuth();
const { activeSandboxId } = useSandbox();
const router = useRouter();

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
</template>
