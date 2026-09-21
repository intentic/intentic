<!-- Mobile action sheet: a PrimeVue Drawer docked to the bottom edge, the touch replacement for Popover/ContextMenu. -->
<script setup lang="ts">
import Drawer from "primevue/drawer";
import { ref } from "vue";
import { useBackDismiss } from "../../composables/useBackDismiss.js";

const { header } = defineProps<{ header?: string }>();
const visible = defineModel<boolean>({ required: true });

useBackDismiss(visible);

// Past this much downward travel the release dismisses; under it the sheet springs back to its docked place.
const DISMISS_PX = 96;

const grip = ref<HTMLElement>();
let panel: HTMLElement | undefined;
let startY = 0;
let travel = 0;
let dragging = false;

// The grab handle is the sheet's one gesture affordance, so it moves the sheet: drawn but inert, it reads as broken.
const onDown = (event: PointerEvent): void => {
    panel = grip.value?.closest(`.p-drawer`) ?? undefined;
    if (panel === undefined) {
        return;
    }
    dragging = true;
    startY = event.clientY;
    travel = 0;
    grip.value?.setPointerCapture(event.pointerId);
};
const onMove = (event: PointerEvent): void => {
    if (!dragging || panel === undefined) {
        return;
    }
    // Downward only: an upward drag would lift the sheet off the bottom edge it is docked to.
    travel = Math.max(0, event.clientY - startY);
    panel.style.transition = `none`;
    panel.style.transform = `translateY(${travel}px)`;
};
const onUp = (): void => {
    if (!dragging) {
        return;
    }
    dragging = false;
    if (panel !== undefined) {
        // Handed back before the close, so PrimeVue's own leave transition plays from the docked place.
        panel.style.transition = ``;
        panel.style.transform = ``;
    }
    if (travel > DISMISS_PX) {
        visible.value = false;
    }
    travel = 0;
};
</script>

<template>
    <Drawer
        v-model:visible="visible"
        position="bottom"
        :show-close-icon="false"
        :block-scroll="true"
        class="!h-auto !max-h-panel-xl !rounded-t-2xl !border-x-0 !border-b-0 !border-t !border-line !bg-card"
        :pt="{ header: { class: `!hidden` }, content: { class: `flex min-h-0 flex-col !overflow-hidden !p-0` } }"
    >
        <!-- `touch-none`: the browser must not read the drag as a scroll, or the sheet never sees the move. -->
        <div
            ref="grip"
            class="shrink-0 touch-none pb-2"
            @pointerdown="onDown"
            @pointermove="onMove"
            @pointerup="onUp"
            @pointercancel="onUp"
        >
            <div class="mx-auto mt-2 h-1 w-9 rounded-full bg-line" aria-hidden="true" />
            <div v-if="header" class="px-4 pt-3 text-sm font-semibold text-content">{{ header }}</div>
        </div>
        <!-- THE ONE SCROLLER IN THE SHEET. It must be the element that overflows: `overscroll-behavior: contain` on a scroll
     container that cannot scroll swallows the finger instead of chaining to whatever can, which is how every tall
     sheet (model picker, chats) stopped moving under touch while the Drawer's own content box held the overflow. -->
        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2" style="overscroll-behavior: contain">
            <slot />
        </div>
    </Drawer>
</template>
