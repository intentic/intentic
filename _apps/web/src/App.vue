<!-- Root shell: the router outlet, the signed-in session's runtime, and the app-global overlays — the single
     Upgrade dialog, the browser→sandbox Google sign-in gate, the suggested-session dialog, and the shell's model
     picker when something outside the chat asks for one. The persistent workspace chrome (rail + docked columns)
     lives in the `/` layout route (shell/WorkspaceShell.vue), so it survives navigation between the shell's child
     pages. All four overlays are mounted here — not in the shell — because they fire outside it too: a plan-gate
     hit opens the dialog from /setup (via useAuth's shared `upgradeOpen`), the sign-in gate is raised on /setup
     when the Google credential is pre-warmed there (see Setup.vue) before the shell ever mounts, a session
     suggestion is raised by a module call from anywhere at all (agents/sessionSuggestion.ts), and the model
     picker is raised by whichever extension view happens to be on screen (chat/hostModelPicker.ts).

     The runtime is here for the same reason and one more: the daemon stream and the poppable chat/terminal
     panels belong to the SESSION, not to a route (shell/WorkspaceRuntime.vue). Its condition is that session's
     definition — an account, and a sandbox for it to be pointed at. Signed out there is nothing to connect to,
     and with no sandbox selected there is nothing to connect to yet. -->
<script setup lang="ts">
import SuggestedSessionDialog from "./agents/SuggestedSessionDialog.vue";
import HostModelPicker from "./chat/HostModelPicker.vue";
import { useAuth } from "./composables/useAuth";
import { useSandbox } from "./composables/sandbox/useSandbox";
import GoogleSigninGate from "./sandbox-gates/GoogleSigninGate.vue";
import UpgradeDialog from "./pages/UpgradeDialog.vue";
import WorkspaceRuntime from "./shell/WorkspaceRuntime.vue";

const { upgradeOpen, user } = useAuth();
const { activeSandboxId } = useSandbox();
</script>

<template>
    <RouterView />
    <WorkspaceRuntime v-if="user && activeSandboxId" />
    <UpgradeDialog v-model:visible="upgradeOpen" />
    <GoogleSigninGate />
    <SuggestedSessionDialog />
    <HostModelPicker />
</template>
