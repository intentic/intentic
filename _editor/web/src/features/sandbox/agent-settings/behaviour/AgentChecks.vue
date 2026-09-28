<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// What happens when main's CI fails. Nothing checks work inside a turn or after it lands any more, and nothing asks
// the model to prove or look at anything when a turn ends: CI checks what is pushed, and a card says what the turn itself
// showed (proofSeal.ts). The one decision left here is whether a failing main gets a fix agent by itself (`autoRepair`).

const t = useT();

const { settings, patch } = useSandboxSettings();
</script>

<template>
    <RowGroup :label="t(`sandbox.agentChecks.mainCi`)">
        <!-- Main's first failed job starts one fix agent, which is sent every later failure on main until a run passes; a
             failure of the CI fleet itself is re-run once instead. -->
        <Row icon="wrench" :title="t(`sandbox.agentChecks.repairMainCi`)" :description="t(`sandbox.agentChecks.repairMainCiNote`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.autoRepair ?? true"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ autoRepair: value })"
                />
            </template>
        </Row>
    </RowGroup>
</template>
