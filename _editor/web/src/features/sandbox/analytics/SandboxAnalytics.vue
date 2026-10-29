<script setup lang="ts">
import { Notice, Row, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useAccess } from "../../../client/sandbox/access/useAccess";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";

// The box's say over Intentic's product analytics, above each person's own setting (analyticsGate.ts reads it). A row,
// not a group: Sandbox ▸ Privacy shield sets it under the shield, the one other thing that sends anything about this box
// out. It sat on Access beside the AI notice until 2026-10-16. It is one of the sandbox's settings, which Full access
// writes, so someone given only the Privacy shield reads it here with who changes it. Until their access is known, the
// switch stands and the daemon decides.

const t = useT();
const { settings, patch, refusal } = useSandboxSettings();
const access = useAccess();
const mayChange = computed(() => !access.known.value || access.can(`settings.set`));
const on = computed(() => settings.value?.productAnalytics ?? true);
</script>

<template>
    <Row icon="eye" :title="t(`sandbox.analytics.title`)">
        <template #control>
            <ToggleSwitch
                v-if="mayChange"
                :model-value="on"
                :disabled="settings === undefined"
                :aria-label="t(`sandbox.analytics.title`)"
                @update:model-value="(value: boolean) => patch({ productAnalytics: value })"
            />
            <span v-else-if="settings !== undefined" class="text-xs text-muted">{{ on ? t(`sandbox.analytics.on`) : t(`sandbox.analytics.off`) }}</span>
        </template>
    </Row>
    <RowNote v-if="!mayChange">{{ t(`sandbox.analytics.whoChanges`) }}</RowNote>
    <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
</template>
