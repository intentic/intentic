<script setup lang="ts">
import { Notice, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";

// How much disk finished builds keep (2026-11-03): one sandbox's idle checkouts once held 424 GB of Rust targets and
// filled the disk every other sandbox and container on that machine shared. When build output in an idle checkout goes,
// how short the disk may get before it all goes at once, and whether agents' Rust builds keep full debug info. The
// checkouts themselves, and what is in them, are Finished work's (AgentFinishedWork) and the Disk card's.

const t = useT();
const { settings, patch, refusal } = useSandboxSettings();

// Hours; strings since SegmentedControl works in strings.
const IDLE_OPTIONS = computed(() => [
    { label: t(`sandbox.agentDiskSpace.n1Hour`), value: `1` },
    { label: t(`sandbox.agentDiskSpace.n6Hours`), value: `6` },
    { label: t(`sandbox.agentDiskSpace.n1Day`), value: `24` },
    { label: t(`sandbox.agentDiskSpace.n1Week`), value: `168` },
]);
// Percent of the disk left free.
const REAP_OPTIONS = [`10`, `15`, `25`].map((value) => ({ label: `${value}%`, value }));
</script>

<template>
    <RowGroup data-setting="agent-disk-space" :label="t(`sandbox.agentDiskSpace.heading`)">
        <Row icon="eraser" :title="t(`sandbox.agentDiskSpace.buildOutputIdle`)" :description="t(`sandbox.agentDiskSpace.buildOutputIdleNote`)">
            <template #control>
                <SegmentedControl
                    :model-value="String(settings?.buildOutputIdleHours ?? 6)"
                    :options="IDLE_OPTIONS"
                    @update:model-value="(hours: string) => patch({ buildOutputIdleHours: Number(hours) })"
                />
            </template>
        </Row>
        <Row icon="database" :title="t(`sandbox.agentDiskSpace.reapBelow`)" :description="t(`sandbox.agentDiskSpace.reapBelowNote`)">
            <template #control>
                <SegmentedControl
                    :model-value="String(settings?.diskReapBelowPercent ?? 15)"
                    :options="REAP_OPTIONS"
                    @update:model-value="(percent: string) => patch({ diskReapBelowPercent: Number(percent) })"
                />
            </template>
        </Row>
        <Row icon="box" :title="t(`sandbox.agentDiskSpace.leanRust`)" :description="t(`sandbox.agentDiskSpace.leanRustNote`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.leanRustBuilds ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ leanRustBuilds: value })"
                />
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
