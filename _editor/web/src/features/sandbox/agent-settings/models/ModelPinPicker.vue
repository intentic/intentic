<script setup lang="ts">
import type { ModelPin } from "@intentic/sandbox-contract";
import { ResponsiveOverlay } from "@intentic/ui";
import ModelPinPickerBody from "./ModelPinPickerBody.vue";

// Frame the settings-page model picker opens in: anchored on desktop, a sheet on phone, split into frame/body like the
// shell picker's (HostModelPicker) since only the frame differs per surface. Mounted once and driven by `open`; the
// body remounts each open, giving it a fresh search box and refreshed catalogs.

const emit = defineEmits<{ "update:open": [boolean]; pick: [ModelPin]; configure: [ModelPin] }>();
const { open, anchor, header, pin, knobs, taken } = defineProps<{
    open: boolean;
    // The trigger the panel hangs off: the row being edited, or the list's own Add button.
    anchor?: HTMLElement | undefined;
    // Overrides the row's wording; needed since this panel looks identical whether editing one job or a selection.
    header?: string | undefined;
    // The entry being re-pointed, or undefined while adding one.
    pin?: ModelPin | undefined;
    // Whether this list's entries carry their own run settings.
    knobs?: boolean;
    // `${provider}:${model}` of every entry already in the list.
    taken?: readonly string[];
}>();
</script>

<template>
    <!--
        Same 26rem panel as the shell's picker. Opens downward, unlike the composer's pinned-to-bottom trigger: these triggers sit mid-page, where
        opening upward would cover the rows above; still flips if room runs out below.
    -->
    <ResponsiveOverlay
        :model-value="open"
        :anchor="anchor"
        :header="header ?? (pin === undefined ? `Add a model` : `Model`)"
        panel-class="w-[26rem]"
        side="bottom"
        @update:model-value="emit(`update:open`, $event)"
    >
        <ModelPinPickerBody
            :pin="pin"
            :knobs="knobs"
            :taken="taken"
            @pick="emit(`pick`, $event)"
            @configure="emit(`configure`, $event)"
            @close="emit(`update:open`, false)"
        />
    </ResponsiveOverlay>
</template>
