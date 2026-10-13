<script setup lang="ts">
import { Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../overview/useSandboxSettings";

const t = useT();
const { settings, patch, refusal } = useSandboxSettings();
</script>

<template>
    <RowGroup :label="t(`sandbox.analytics.title`)">
        <Row icon="shield" :title="t(`sandbox.analytics.title`)" :description="t(`sandbox.analytics.description`)">
            <template #control>
                <ToggleSwitch :model-value="settings?.productAnalytics ?? true" :disabled="settings === undefined" :aria-label="t(`sandbox.analytics.title`)" @update:model-value="(value: boolean) => patch({ productAnalytics: value })" />
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
