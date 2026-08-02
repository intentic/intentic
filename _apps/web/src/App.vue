<!-- Root shell: the router outlet plus the app-global overlays — the single Upgrade dialog, the browser→sandbox
     Google sign-in gate, the suggested-session dialog, and the shell's model picker when something outside the
     chat asks for one. The persistent workspace chrome (rail + chat) lives in the `/` layout route
     (shell/WorkspaceShell.vue), so it survives navigation between the shell's child pages. All four overlays are
     mounted here — not in the shell — because they fire outside it too: a plan-gate hit opens the dialog from
     /setup (via useAuth's shared `upgradeOpen`), the sign-in gate is raised on /setup when the Google credential
     is pre-warmed there (see Setup.vue) before the shell ever mounts, a session suggestion is raised by a module
     call from anywhere at all (agents/sessionSuggestion.ts), and the model picker is raised by whichever
     extension view happens to be on screen (chat/hostModelPicker.ts). -->
<script setup lang="ts">
import SuggestedSessionDialog from "./agents/SuggestedSessionDialog.vue";
import HostModelPicker from "./chat/HostModelPicker.vue";
import { useAuth } from "./composables/useAuth";
import GoogleSigninGate from "./sandbox-gates/GoogleSigninGate.vue";
import UpgradeDialog from "./pages/UpgradeDialog.vue";

const { upgradeOpen } = useAuth();
</script>

<template>
    <RouterView />
    <UpgradeDialog v-model:visible="upgradeOpen" />
    <GoogleSigninGate />
    <SuggestedSessionDialog />
    <HostModelPicker />
</template>
