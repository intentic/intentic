<script setup lang="ts">
import { Row, RowGroup, RowNote } from "@intentic/ui";
import { useRole } from "../secrets/useRole";
import ArrivalPanel from "./ArrivalPanel.vue";
import MoveOutPanel from "./MoveOutPanel.vue";

// Both move directions live on one card; the role check is here, not duplicated in each panel. RowNote variant="block"
// takes the group's own padding (ROW_BLOCK_PAD) — don't add p-5 by hand.

const { canShip: canOperate } = useRole();
</script>

<template>
    <RowGroup label="Move this sandbox">
        <template v-if="canOperate">
            <RowNote variant="block">
                <div class="flex flex-col gap-4">
                    <Row flush density="comfortable" :heading="3" icon="arrow-up-right" title="Export" />
                    <MoveOutPanel />
                </div>
            </RowNote>

            <RowNote variant="block">
                <div class="flex flex-col gap-4">
                    <Row flush density="comfortable" :heading="3" icon="arrow-down-left" title="Import" />
                    <ArrivalPanel />
                </div>
            </RowNote>
        </template>

        <RowNote v-else icon="lock">Owner only.</RowNote>
    </RowGroup>
</template>
