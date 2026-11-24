<script setup lang="ts">
import { InfoHint, Notice, Picker, type PickerOption, Row } from "@intentic/ui";
import { formatPercent } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";

// What keeps the disk from filling by itself, said as the rules it follows and changed where they are read
// (2026-11-24, from Agent settings' Disk space group): when an idle conversation's build output goes, how short the
// disk may get before every idle one's goes at once, and how much agents' Rust builds keep. Each pick saves on its own.
// One sandbox's idle checkouts once held 424 GB of Rust targets and filled a disk other sandboxes shared (2026-11-03).

const t = useT();
const { settings, patch, refusal } = useSandboxSettings();
const disabled = computed(() => settings.value === undefined);

// Hours and percents travel as strings, since a picker's values are.
const IDLE = computed<readonly PickerOption[]>(() => [
    { value: `1`, label: t(`sandbox.agentDiskSpace.n1Hour`) },
    { value: `6`, label: t(`sandbox.agentDiskSpace.n6Hours`) },
    { value: `24`, label: t(`sandbox.agentDiskSpace.n1Day`) },
    { value: `168`, label: t(`sandbox.agentDiskSpace.n1Week`) },
]);
const REAP = computed<readonly PickerOption[]>(() => [`10`, `15`, `25`].map((value) => ({ value, label: formatPercent(Number(value)) })));
const DEBUG = computed<readonly PickerOption<`full` | `lean`>[]>(() => [
    { value: `full`, label: t(`sandbox.diskRules.fullDebug`) },
    { value: `lean`, label: t(`sandbox.diskRules.leanDebug`), hint: t(`sandbox.agentDiskSpace.leanRustNote`) },
]);
const INCREMENTAL = computed<readonly PickerOption<`on` | `off`>[]>(() => [
    { value: `on`, label: t(`sandbox.diskRules.incrementalOn`) },
    { value: `off`, label: t(`sandbox.diskRules.incrementalOff`), hint: t(`sandbox.agentDiskSpace.rustIncrementalOffNote`) },
]);
</script>

<template>
    <Row :title="t(`sandbox.diskRules.title`)" data-disk-rules>
        <template #title>
            <span class="inline-flex items-center gap-1.5">
                {{ t(`sandbox.diskRules.title`) }}
                <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`sandbox.diskRules.title`) })">
                    <span class="flex flex-col gap-2 text-xs text-content">
                        <span>{{ t(`sandbox.agentDiskSpace.buildOutputIdleNote`) }}</span>
                        <span>{{ t(`sandbox.agentDiskSpace.reapBelowNote`) }}</span>
                    </span>
                </InfoHint>
            </span>
        </template>
        <template #below>
            <div class="flex flex-col gap-0.5 text-sm leading-7 text-muted">
                <i18n-t keypath="sandbox.diskRules.buildOutput" tag="div" scope="global">
                    <template #after>
                        <Picker
                            variant="ghost"
                            :options="IDLE"
                            :model-value="String(settings?.buildOutputIdleHours ?? 6)"
                            :disabled="disabled"
                            :aria-label="t(`sandbox.agentDiskSpace.buildOutputIdle`)"
                            :header="t(`sandbox.agentDiskSpace.buildOutputIdle`)"
                            data-disk-rule="buildOutputIdleHours"
                            @update:model-value="(hours?: string) => hours !== undefined && patch({ buildOutputIdleHours: Number(hours) })"
                        />
                    </template>
                </i18n-t>
                <i18n-t keypath="sandbox.diskRules.reap" tag="div" scope="global">
                    <template #below>
                        <Picker
                            variant="ghost"
                            :options="REAP"
                            :model-value="String(settings?.diskReapBelowPercent ?? 15)"
                            :disabled="disabled"
                            :aria-label="t(`sandbox.agentDiskSpace.reapBelow`)"
                            :header="t(`sandbox.agentDiskSpace.reapBelow`)"
                            data-disk-rule="diskReapBelowPercent"
                            @update:model-value="(percent?: string) => percent !== undefined && patch({ diskReapBelowPercent: Number(percent) })"
                        />
                    </template>
                </i18n-t>
                <i18n-t keypath="sandbox.diskRules.rust" tag="div" scope="global">
                    <template #debug>
                        <Picker
                            variant="ghost"
                            :options="DEBUG"
                            :model-value="settings?.leanRustBuilds === true ? `lean` : `full`"
                            :disabled="disabled"
                            :aria-label="t(`sandbox.agentDiskSpace.leanRust`)"
                            :header="t(`sandbox.agentDiskSpace.leanRust`)"
                            data-disk-rule="leanRustBuilds"
                            @update:model-value="(debug?: `full` | `lean`) => debug !== undefined && patch({ leanRustBuilds: debug === `lean` })"
                        />
                    </template>
                    <template #incremental>
                        <Picker
                            variant="ghost"
                            :options="INCREMENTAL"
                            :model-value="settings?.rustIncrementalOff === true ? `off` : `on`"
                            :disabled="disabled"
                            :aria-label="t(`sandbox.agentDiskSpace.rustIncrementalOff`)"
                            :header="t(`sandbox.agentDiskSpace.rustIncrementalOff`)"
                            data-disk-rule="rustIncrementalOff"
                            @update:model-value="(incremental?: `on` | `off`) => incremental !== undefined && patch({ rustIncrementalOff: incremental === `off` })"
                        />
                    </template>
                </i18n-t>
                <Notice v-if="refusal !== undefined" :of="refusal" class="mt-1" />
            </div>
        </template>
    </Row>
</template>
