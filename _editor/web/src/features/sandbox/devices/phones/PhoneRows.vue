<!-- The owner's phones on the Devices board: whether the agent can reach each now, and the way to its card. -->
<script setup lang="ts">
import { BrandMark, Notice, Row, RowGroup, StatusBadge } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { capabilityRoute } from "../../../../models/sandbox/devices/deviceLinks";
import { PHONE_DOOR, usePeerConnect } from "../../../../models/sandbox/devices/usePeerConnect";
import { phoneRowOf, phoneStateWord } from "./phoneRows";

const t = useT();

// The phone roster: the shared cache entry, read on open and again whenever a phone connects or drops; never polled.
const { peers, rosterNotice } = usePeerConnect(PHONE_DOOR);

const rows = computed(() => peers.value.map(phoneRowOf));
</script>

<template>
    <Notice v-if="rosterNotice" tone="warning">{{ rosterNotice }}</Notice>
    <RowGroup v-if="rows.length > 0" :label="t(`sandbox.phoneRows.phones`)">
        <Row v-for="row in rows" :key="row.id">
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <!-- The phone's own OS mark, as a machine's tile wears its own; a platform drawn by nobody keeps the handset. -->
                    <BrandMark
                        :size="16"
                        :name="row.id"
                        :icon="row.platform === `android` ? `android` : row.platform === `ios` ? `apple` : `mobile`"
                        :tint="row.platform === `android` ? `#3DDC84` : row.platform === `ios` ? `#000000` : undefined"
                        :plain="true"
                        :idle="row.tone === `neutral`"
                    />
                    <span class="truncate font-mono">{{ row.id }}</span>
                    <StatusBadge size="xs" :dot="true" :variant="row.tone" :label="phoneStateWord(row.state)" />
                </span>
            </template>
            <template v-if="row.detail" #description>
                <span class="block truncate">{{ row.detail }}</span>
            </template>
            <template #control>
                <RouterLink :to="capabilityRoute(row.platform, { edit: row.id })" class="text-sm text-link hover:underline">
                    {{ t(`sandbox.phoneRows.manage`) }}
                </RouterLink>
            </template>
        </Row>
    </RowGroup>
</template>
