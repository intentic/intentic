<script setup lang="ts">
import { RowGroup, RowNote } from "@intentic/ui";
import { useRole } from "../secrets/useRole";
import ArrivalPanel from "./ArrivalPanel.vue";

// Card chrome and the role check for the inbound direction; the panel draws only its own rows. RowNote variant="block"
// takes the group's own padding (ROW_BLOCK_PAD) — don't add p-5 by hand.

const { canShip: canOperate } = useRole();
</script>

<template>
    <RowGroup label="Import">
        <RowNote v-if="canOperate" variant="block"><ArrivalPanel /></RowNote>
        <RowNote v-else icon="lock">Owner only.</RowNote>
    </RowGroup>
</template>
