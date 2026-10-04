<!-- The owner's switch for updates that take themselves: a line under the offer's facts, or a row of the quiet group
     when there is no offer. On by default at the daemon; only a maintainer can flip it, everyone else reads it. -->
<script setup lang="ts">
import { Notice, Row } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { useId } from "vue";
import { useAutoUpdate } from "./useAutoUpdate";

const t = useT();

const { row = false } = defineProps<{
    /** Drawn as a row of the card's quiet group, rather than a line under the offer. */
    row?: boolean;
}>();

const { auto, served, canSteer, setEnabled } = useAutoUpdate();
const { busy, notice, run } = useAsyncAction();
const flip = (on: boolean): void => {
    void run(() => setEnabled(on), t(`sandbox.autoUpdate.couldntChange`));
};
const id = useId();
</script>

<template>
    <template v-if="served && auto">
        <Row v-if="row" icon="refresh" :title="t(`sandbox.autoUpdate.switchTitle`)" :description="t(`sandbox.autoUpdate.switchNote`)">
            <template #control>
                <ToggleSwitch :model-value="auto.enabled" :disabled="!canSteer || busy" :aria-label="t(`sandbox.autoUpdate.switchTitle`)" @update:model-value="flip" />
            </template>
        </Row>
        <div v-else class="flex items-center gap-2">
            <ToggleSwitch :input-id="id" :model-value="auto.enabled" :disabled="!canSteer || busy" class="ui-switch-sm shrink-0" @update:model-value="flip" />
            <label :for="id" v-tooltip.top="{ title: t(`sandbox.autoUpdate.switchTipTitle`), note: t(`sandbox.autoUpdate.switchTipNote`) }" class="cursor-pointer text-2xs text-muted">{{ t(`sandbox.autoUpdate.switchTitle`) }}</label>
        </div>
        <Notice v-if="notice" :of="notice" />
    </template>
</template>
