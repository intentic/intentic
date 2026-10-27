<script setup lang="ts">
import { RowGroup, RowNote } from "@intentic/ui";
import { useRole } from "../../../client/sandbox/useRole";
import MoveOutPanel from "./MoveOutPanel.vue";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { accessWords } from "../../../client/sandbox/access/accessWords";

// Card chrome and the role check for the outbound direction; the panel draws only its own rows. RowNote variant="block"
// takes the group's own padding (ROW_BLOCK_PAD) — don't add p-5 by hand.

const t = useT();

const { canShip: canOperate } = useRole();
// Who it is for, in the words every refusal uses: moving a sandbox is a maintainer's, as the daemon holds it.
const maintainersOnly = computed(() => accessWords({ kind: `tier`, floor: `maintainer` }).short);
</script>

<template>
    <RowGroup data-setting="environment-export" :label="t(`sandbox.words.export`)">
        <RowNote v-if="canOperate" variant="block"><MoveOutPanel /></RowNote>
        <RowNote v-else icon="lock">{{ maintainersOnly }}</RowNote>
    </RowGroup>
</template>
