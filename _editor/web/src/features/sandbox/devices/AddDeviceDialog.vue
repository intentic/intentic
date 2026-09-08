<script setup lang="ts">
import { Modal } from "@intentic/ui";
import DesktopSyncCard from "./DesktopSyncCard.vue";

// Pairing a machine is a task, not a state to read, so it lives in a box you open and close rather than in
// a permanently-expanded card at the foot of the board.

const open = defineModel<boolean>(`open`, { required: true });
</script>

<template>
    <Modal v-model:open="open" size="lg" header="Add a device">
        <DesktopSyncCard />
    </Modal>
</template>
