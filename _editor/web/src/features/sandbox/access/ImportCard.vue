<script setup lang="ts">
import { RowGroup, RowNote } from "@intentic/ui";
import { useRole } from "../secrets/useRole";
import ArrivalPanel from "./ArrivalPanel.vue";
import { useT } from "@intentic/ui/i18n";

// Card chrome and the role check for the inbound direction; the panel draws only its own rows. RowNote variant="block"
// takes the group's own padding (ROW_BLOCK_PAD) — don't add p-5 by hand.

const t = useT();

const { canShip: canOperate } = useRole();
</script>

<template>
    <RowGroup :label="t(`sandbox.importCard.import`)">
        <RowNote v-if="canOperate" variant="block"><ArrivalPanel /></RowNote>
        <RowNote v-else icon="lock">{{ t(`sandbox.importCard.ownerOnly`) }}</RowNote>
    </RowGroup>
</template>
