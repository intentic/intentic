<!-- WHETHER THE COMPUTER THIS SANDBOX RUNS ON MAY PUT IT TO SLEEP (settings `sleepWhenUnused`, read by the daemon's quiet
     watch: off, it never tells its host's keeper it is unneeded). A row of the Overview's facts, beside its share of the
     machine, since both are about the machine it stands on. Drawn only for a sandbox on somebody's own machine, as a
     hosted one's idle stop is its plan's, and only once the daemon's settings carry the field, since an older daemon
     would drop it. Changing it is a settings write, maintainer and up at the daemon, so a member below reads it. -->
<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, useId } from "vue";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";

const t = useT();

const sandbox = useSandbox();
const { canShip } = useRole();
const { settings, patch, refusal, save } = useSandboxSettings();

const hosted = computed(() => (sandbox.active.value?.hosted ?? null) !== null);
const on = computed(() => settings.value?.sleepWhenUnused);
const shown = computed(() => !hosted.value && on.value !== undefined);
const id = useId();
</script>

<template>
    <div v-if="shown" data-setting="overview-sleep" class="grid gap-x-3 gap-y-0.5 @md:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
        <dt class="text-subtle">
            <label :for="id" class="cursor-pointer">{{ t(`sandbox.sandboxOverview.sleep`) }}</label>
        </dt>
        <dd class="flex min-w-0 flex-col gap-1 @md:items-end">
            <div class="flex min-w-0 items-center gap-2">
                <span
                    v-tooltip.top="{ title: t(`sandbox.sandboxOverview.sleep`), note: t(`sandbox.sandboxOverview.sleepTipNote`) }"
                    class="min-w-0 break-words text-content"
                    >{{ on ? t(`sandbox.sandboxOverview.sleepOn`) : t(`sandbox.sandboxOverview.sleepOff`) }}</span
                >
                <ToggleSwitch
                    :input-id="id"
                    :model-value="on"
                    :disabled="!canShip || save.isPending.value"
                    class="ui-switch-sm shrink-0"
                    @update:model-value="(value: boolean) => patch({ sleepWhenUnused: value })"
                />
            </div>
            <Notice v-if="refusal" :of="refusal" />
        </dd>
    </div>
</template>
