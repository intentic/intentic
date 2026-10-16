<script setup lang="ts">
import { Notice, Row, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../overview/useSandboxSettings";

// The box's say over Intentic's product analytics, above each person's own setting (analyticsGate.ts reads it). A row,
// not a group: Sandbox ▸ Privacy shield sets it under the shield, the one other thing that sends anything about this box
// out. It sat on Access beside the AI notice until 2026-10-16.

const t = useT();
const { settings, patch, refusal } = useSandboxSettings();
</script>

<template>
    <Row icon="eye" :title="t(`sandbox.analytics.title`)">
        <template #control>
            <ToggleSwitch
                :model-value="settings?.productAnalytics ?? true"
                :disabled="settings === undefined"
                :aria-label="t(`sandbox.analytics.title`)"
                @update:model-value="(value: boolean) => patch({ productAnalytics: value })"
            />
        </template>
    </Row>
    <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
</template>
