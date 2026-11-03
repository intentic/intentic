<!-- THE HOST GPU, FOR A SANDBOX WHOSE GPU SWITCH IS ON (settings `gpu`, read by the daemon's hosts/gpu/gpu-state.ts and
     by bin/gpu-run). On a Windows PC that GPU is the owner's display GPU, shared through WSL, so agents get it on request
     (`gpu-run <command>`) unless this switch gives it to every command they run. After the computer reported a GPU reset
     the daemon pauses GPU work (`gpu.pausedFor`), and this row is where the owner reads why and resumes it. A row of the
     Overview's facts beside the sleep switch, since both are about the machine it stands on. Drawn only where the Docker
     capability asks for the GPU, or something about the GPU is already set; changing it is a settings write. -->
<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, useId } from "vue";
import { useRole } from "../../../client/sandbox/useRole";
import { useCapabilities } from "../../../models/capabilities/useCapabilities";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";

const t = useT();

const { canShip } = useRole();
const { settings, patch, refusal, save } = useSandboxSettings();
const { capabilities } = useCapabilities();

const gpu = computed(() => settings.value?.gpu);
// The Docker capability echoes its GPU ask as a boolean (docker.handler.ts `echo`).
const asked = computed(() => capabilities.value.some((capability) => capability.kind === `docker` && capability.config[`gpu`] === true));
const shown = computed(() => gpu.value !== undefined && (asked.value || gpu.value.pausedFor !== undefined || gpu.value.shells === `all`));
const all = computed(() => gpu.value?.shells === `all`);
const id = useId();

const resume = (): void => {
    if (gpu.value === undefined) {
        return;
    }
    const { pausedFor: _cleared, ...rest } = gpu.value;
    patch({ gpu: rest });
};
const setAll = (value: boolean): void => {
    if (gpu.value !== undefined) {
        patch({ gpu: { ...gpu.value, shells: value ? `all` : `on-request` } });
    }
};
</script>

<template>
    <div v-if="shown && gpu" data-setting="overview-gpu" class="grid gap-x-3 gap-y-0.5 @md:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
        <dt class="text-subtle">
            <label :for="canShip ? id : undefined" :class="{ 'cursor-pointer': canShip }">{{ t(`sandbox.sandboxOverview.gpu`) }}</label>
        </dt>
        <dd class="flex min-w-0 flex-col gap-1 @md:items-end">
            <div v-if="gpu.pausedFor !== undefined" data-gpu="paused" class="flex min-w-0 flex-col gap-1 @md:items-end">
                <span class="min-w-0 break-words text-warning">{{ t(`sandbox.sandboxOverview.gpuPaused`, { reason: gpu.pausedFor }) }}</span>
                <button
                    v-if="canShip"
                    type="button"
                    class="shrink-0 font-medium text-link hover:underline"
                    :disabled="save.isPending.value"
                    @click="resume"
                >
                    {{ t(`sandbox.sandboxOverview.gpuResume`) }}
                </button>
            </div>
            <div class="flex min-w-0 items-center gap-2">
                <span
                    v-tooltip.top="{ title: t(`sandbox.sandboxOverview.gpu`), note: t(`sandbox.sandboxOverview.gpuTipNote`) }"
                    class="min-w-0 break-words text-content"
                    >{{ all ? t(`sandbox.sandboxOverview.gpuAll`) : t(`sandbox.sandboxOverview.gpuOnRequest`) }}</span
                >
                <ToggleSwitch
                    v-if="canShip"
                    :input-id="id"
                    :model-value="all"
                    :disabled="save.isPending.value"
                    class="ui-switch-sm shrink-0"
                    @update:model-value="setAll"
                />
            </div>
            <Notice v-if="refusal" :of="refusal" />
        </dd>
    </div>
</template>
