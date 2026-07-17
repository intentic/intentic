<!-- Root shell: the router outlet plus the app's single Upgrade dialog. The persistent workspace chrome
     (rail + chat) lives in the `/` layout route (shell/WorkspaceShell.vue), so it survives navigation between
     the shell's child pages. The dialog is mounted here — not in the shell — because plan-gate hits can happen
     outside it too (the /setup page); any gate anywhere opens it via useAuth's shared `upgradeOpen`. -->
<script setup lang="ts">
import { useAuth } from "./composables/useAuth";
import UpgradeDialog from "./pages/UpgradeDialog.vue";

const { upgradeOpen } = useAuth();
</script>

<template>
    <RouterView />
    <UpgradeDialog v-model:visible="upgradeOpen" />
</template>
