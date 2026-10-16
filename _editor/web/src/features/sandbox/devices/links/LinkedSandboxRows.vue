<!-- The owner's other sandboxes this one may hand tasks to, on the Devices board beside their computers and phones: whether each answers now, and the way to its card. -->
<script setup lang="ts">
import { Row, RowGroup, StatusBadge } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useCapabilities } from "../../../../models/capabilities/useCapabilities";
import { capabilityRoute } from "../../../../models/sandbox/devices/deviceLinks";
import { linkedSandboxRowsOf } from "./linkedSandboxRows";

const t = useT();

// The link cards themselves, with the status their handler last read off the far sandbox (link.handler.ts): nothing
// here dials it again.
const { capabilities } = useCapabilities();
const rows = computed(() => linkedSandboxRowsOf(capabilities.value));

const stateWord = (state: (typeof rows.value)[number][`state`]): string =>
    state === `online` ? t(`sandbox.linkedSandboxRows.online`) : state === `revoked` ? t(`sandbox.linkedSandboxRows.revoked`) : t(`sandbox.linkedSandboxRows.notAnswering`);
</script>

<template>
    <RowGroup v-if="rows.length > 0" :label="t(`sandbox.linkedSandboxRows.title`)">
        <Row v-for="row in rows" :key="row.id" icon="link">
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <span class="truncate font-mono">{{ row.name }}</span>
                    <StatusBadge size="xs" :dot="true" :variant="row.tone" :label="stateWord(row.state)" />
                </span>
            </template>
            <template v-if="row.detail" #description>
                <span class="block truncate">{{ row.detail }}</span>
            </template>
            <template #control>
                <RouterLink :to="capabilityRoute(`link`, { edit: row.id })" class="text-sm text-link hover:underline">
                    {{ t(`sandbox.linkedSandboxRows.manage`) }}
                </RouterLink>
            </template>
        </Row>
    </RowGroup>
</template>
