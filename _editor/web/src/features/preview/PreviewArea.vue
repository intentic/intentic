<!-- Desktop /preview route that hosts the preview panel and its detached-window recall. -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import { useRoute } from "vue-router";
import { markPreviewOpened, selectPreviewTarget } from "./previewSurface";
import { usePreviewFloating } from "./previewFloating";
import { previewSlot } from "../../shell/window/panelSlots";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { floats, dock } = usePreviewFloating();
const route = useRoute();

// Standing here is what makes the panel exist at all (previewSurface.opened): a bookmark or a hand-typed
// /preview arrives without any control having marked it, and an area publishing a slot nothing mounts into
// would be a blank page.
markPreviewOpened();

// `/preview?target=repo:shop` picks the target the way the panel's own switcher does, so a link from outside this area
// (an extension's See it) lands on the thing it names rather than on whatever was shown last. Read on every
// arrival, since the same route with a new query is not a remount.
watch(
    () => route.query[`target`],
    (target) => {
        if (typeof target === `string` && target !== ``) {
            selectPreviewTarget(target);
        }
    },
    { immediate: true },
);

const slot = useTemplateRef(`slot`);
onMounted(() => {
    previewSlot.value = slot.value;
});
onUnmounted(() => {
    previewSlot.value = null;
});
</script>

<template>
    <div class="relative h-full w-full">
        <!-- Published even while another window holds the panel, so "Bring it back here" lands it in this slot the instant the window goes. -->
        <div ref="slot" class="contents"></div>
        <div v-if="floats" class="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <Icon name="external-link" class="text-3xl text-subtle" />
            <div>
                <p class="text-sm font-medium text-content">{{ t(`preview.previewArea.previewInOwnWindow`) }}</p>
                <p class="mt-1 text-xs text-muted">{{ t(`preview.previewArea.bringBackToFill`) }}</p>
            </div>
            <Button size="small" @click="dock()"> <Icon name="sign-in" />{{ t(`preview.previewArea.bringBackHere`) }} </Button>
        </div>
    </div>
</template>
