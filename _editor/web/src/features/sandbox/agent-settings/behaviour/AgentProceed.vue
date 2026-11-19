<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// Whether agents carry on with their own recommendation instead of stopping for a go-ahead (`proceedWithoutAsking`,
// the daemon's agent/run/decide/proceed.ts). Off by default; any one conversation can say otherwise from its card's menu,
// and its subagents follow it. Night hours decide while they are in force.

const t = useT();

const { settings, patch } = useSandboxSettings();
</script>

<template>
    <RowGroup data-setting="agent-proceed" :label="t(`sandbox.agentProceed.group`)">
        <Row icon="play" :title="t(`sandbox.agentProceed.title`)" :description="t(`sandbox.agentProceed.description`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.proceedWithoutAsking ?? false"
                    :disabled="settings === undefined"
                    :aria-label="t(`sandbox.agentProceed.title`)"
                    @update:model-value="(value: boolean) => patch({ proceedWithoutAsking: value })"
                />
            </template>
        </Row>
    </RowGroup>
</template>
