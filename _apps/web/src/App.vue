<!-- Root shell: the router outlet plus the app-global overlays — the single Upgrade dialog and the
     browser→sandbox Google sign-in gate. The persistent workspace chrome (rail + chat) lives in the `/` layout
     route (shell/WorkspaceShell.vue), so it survives navigation between the shell's child pages. Both overlays
     are mounted here — not in the shell — because they fire outside it too: a plan-gate hit opens the dialog
     from /setup (via useAuth's shared `upgradeOpen`), and the sign-in gate is raised on /setup when the Google
     credential is pre-warmed there (see Setup.vue), before the shell ever mounts. -->
<script setup lang="ts">
import { useAuth } from "./composables/useAuth";
import GoogleSigninGate from "./sandbox-gates/GoogleSigninGate.vue";
import UpgradeDialog from "./pages/UpgradeDialog.vue";

const { upgradeOpen } = useAuth();
</script>

<template>
    <RouterView />
    <UpgradeDialog v-model:visible="upgradeOpen" />
    <GoogleSigninGate />
</template>
