<script setup lang="ts">
import { Modal } from "@intentic/ui";
import DesktopSyncCard from "./sync/DesktopSyncCard.vue";
import { useT } from "@intentic/ui/i18n";

// Pairing a machine is a task, not a state to read, so it lives in a box you open and close rather than in
// a permanently-expanded card at the foot of the board.

const t = useT();

const open = defineModel<boolean>(`open`, { required: true });
</script>

<template>
    <Modal v-model:open="open" size="lg" :header="t(`shared.addDevice`)">
        <DesktopSyncCard />
    </Modal>
</template>
