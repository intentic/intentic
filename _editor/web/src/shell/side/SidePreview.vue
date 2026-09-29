<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { onMounted, onUnmounted, useTemplateRef } from "vue";
import { usePreviewFloating } from "../../features/preview/previewFloating";
import { markPreviewOpened } from "../../features/preview/previewSurface";
import type { LineJump } from "../../features/workspace/tabs/workspaceTabs";
import { sidePreviewSlot } from "../window/panelSlots";
import type { SideInput } from "./sideTabs";

// The running app beside the section: this tab publishes the preview's side slot and the one preview panel a window has
// moves in (PoppablePanels.vue). Which target it shows is the panel's own picker, so the tab holds no input of its own.
// The /preview section outranks this slot, and a window of its own takes the panel from both.

// The side panel's contract for every body; the preview reads neither.
defineProps<{ input: SideInput; jump?: LineJump }>();

const t = useT();
const { floats, dock } = usePreviewFloating();

// Standing here is what makes the panel exist at all, as on /preview: a tab restored after a reload has no control that
// marked it.
markPreviewOpened();

const slot = useTemplateRef(`slot`);
onMounted(() => {
    sidePreviewSlot.value = slot.value;
});
onUnmounted(() => {
    if (sidePreviewSlot.value === slot.value) {
        sidePreviewSlot.value = null;
    }
});
</script>

<template>
    <div class="relative flex min-h-0 flex-1 flex-col">
        <!-- Published even while another window holds the panel, so "Bring it back here" lands it in this tab. -->
        <div ref="slot" class="contents"></div>
        <div v-if="floats" class="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <Icon name="external-link" class="text-3xl text-subtle" />
            <p class="text-sm font-medium text-content">{{ t(`preview.previewArea.previewInOwnWindow`) }}</p>
            <Button size="small" @click="dock()"> <Icon name="sign-in" />{{ t(`preview.previewArea.bringBackHere`) }} </Button>
        </div>
    </div>
</template>
