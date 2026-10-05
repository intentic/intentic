<!-- The owner's phones on the Devices board: whether the agent can reach each now, and the way to its card. -->
<script setup lang="ts">
import type { PhoneSummary } from "@intentic/sandbox-contract";
import { Icon, Row, RowGroup, StatusBadge } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted } from "vue";
import { capabilityRoute } from "../deviceLinks";
import { PHONE_DOOR, usePeerConnect } from "../usePeerConnect";
import { phoneRowOf } from "./phoneRows";

const t = useT();

// The phone roster, read once on open and again whenever a phone connects or drops; never polled.
const { peers, start, stop } = usePeerConnect<PhoneSummary>(PHONE_DOOR);
onMounted(start);
onBeforeUnmount(stop);

const rows = computed(() => peers.value.map(phoneRowOf));
</script>

<template>
    <RowGroup v-if="rows.length > 0" :label="t(`sandbox.phoneRows.phones`)">
        <Row v-for="row in rows" :key="row.id">
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <Icon name="mobile" class="shrink-0 text-muted" aria-hidden="true" />
                    <span class="truncate font-mono">{{ row.id }}</span>
                    <StatusBadge size="xs" :dot="true" :variant="row.tone" :label="row.state" />
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
