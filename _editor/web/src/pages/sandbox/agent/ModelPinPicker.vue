<script setup lang="ts">
import type { AgentRunPin } from "@intentic/sandbox-contract";
import { ResponsiveOverlay } from "@intentic/ui";
import ModelPinPickerBody from "./ModelPinPickerBody.vue";

/* THE FRAME THE SETTINGS PAGE'S MODEL PICKER OPENS IN: anchored to whichever row or Add button raised it on a
 * desktop, the same panel as a thumb-reachable sheet on a phone. The split is the shell picker's
 * (HostModelPicker + HostPickerBody) and exists for the same two reasons: the frame is the only part that
 * differs per surface, and the body is then a plain component that can be mounted and asked what it drew.
 *
 * MOUNTED, NOT CREATED PER OPEN, and `open` drives it. AnchoredOverlay measures and places its box in a
 * watcher on that flag, so a host that arrives already open never places at all and the panel parks off-screen
 * (ResponsiveOverlay's own header says so). The BODY is what remounts per open, which is what gives the list a
 * fresh search box and freshly refreshed catalogs each time. */

const emit = defineEmits<{ "update:open": [boolean]; pick: [AgentRunPin]; configure: [AgentRunPin] }>();
const { open, anchor, pin, knobs, taken } = defineProps<{
    open: boolean;
    // The trigger the panel hangs off: the row being edited, or the list's own Add button.
    anchor?: HTMLElement | undefined;
    // The entry being re-pointed, or undefined while ADDING one.
    pin?: AgentRunPin | undefined;
    // Whether this list's entries carry their own run settings. See ModelPinPickerBody.
    knobs?: boolean;
    // `${provider}:${model}` of every entry already in the list.
    taken?: readonly string[];
}>();
</script>

<template>
    <!-- 26rem, the width the shell's own picker uses: the two are the same panel and should not be told apart.
         DOWNWARD, unlike the composer's, which is the one placement difference and follows from where the
         trigger is. A composer pill sits at the foot of the window, so its panel can only open upward; these
         triggers are rows in the middle of a settings page, where a panel that opens upward covers the rows
         you were just reading, and the control it replaces (<Picker>) opened downward. AnchoredOverlay still
         flips it when the room below genuinely runs out. -->
    <ResponsiveOverlay
        :model-value="open"
        :anchor="anchor"
        :header="pin === undefined ? `Add a model` : `Model`"
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
