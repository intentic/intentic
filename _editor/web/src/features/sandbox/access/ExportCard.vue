<script setup lang="ts">
import { RowGroup, RowNote } from "@intentic/ui";
import { useRole } from "../secrets/useRole";
import MoveOutPanel from "./MoveOutPanel.vue";

// Card chrome and the role check for the outbound direction; the panel draws only its own rows. RowNote variant="block"
// takes the group's own padding (ROW_BLOCK_PAD) — don't add p-5 by hand.

const { canShip: canOperate } = useRole();
</script>

<template>
    <RowGroup label="Export">
        <RowNote v-if="canOperate" variant="block"><MoveOutPanel /></RowNote>
        <RowNote v-else icon="lock">Owner only.</RowNote>
    </RowGroup>
</template>
