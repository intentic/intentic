<script setup lang="ts">
import { Button, EmptyState } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useTemplateRef } from "vue";
import { useBrowsersFloating } from "../../workbench/browsers/browsersFloating";
import { markBrowsersOpened } from "../../workbench/browsers/browsersSurface";
import type { LineJump } from "../../features/workspace/tabs/workspaceTabs";
import { publishSlot, sideBrowsersSlot } from "../../workbench/window/panelSlots";
import type { SideInput } from "../../workbench/side/sideTabs";

// Browsers beside the section: this tab publishes the view's side slot and the one Browsers view a window has moves in
// (PoppablePanels.vue), with every tab it holds: the running app, a web window, the desktop. Which tab is in front is the
// view's own strip, so the side tab holds no input of its own. The /browsers section outranks this slot, and a window of
// its own takes the view from both.

// The side panel's contract for every body; this one reads neither.
defineProps<{ input: SideInput; jump?: LineJump }>();

const t = useT();
const { floats, dock } = useBrowsersFloating();

// Standing here is what makes the view exist at all, as on /browsers: a tab restored after a reload has no control that
// marked it.
markBrowsersOpened();

const slot = useTemplateRef(`slot`);
publishSlot(sideBrowsersSlot, () => slot.value);
</script>

<template>
    <div class="relative flex min-h-0 flex-1 flex-col">
        <!-- Published even while another window holds the view, so "Bring it back here" lands it in this tab. -->
        <div ref="slot" class="contents"></div>
        <EmptyState v-if="floats" icon="external-link" :title="t(`browsers.area.inOwnWindow`)" class="absolute inset-0 p-6">
            <template #actions>
                <Button size="small" @click="dock()"> <Icon name="sign-in" />{{ t(`browsers.area.bringBackHere`) }} </Button>
            </template>
        </EmptyState>
    </div>
</template>
