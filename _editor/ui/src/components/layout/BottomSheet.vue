<!-- Mobile action sheet: a PrimeVue Drawer docked to the bottom edge, the touch replacement for Popover/ContextMenu. -->
<script setup lang="ts">
import Drawer from "primevue/drawer";

const { header } = defineProps<{ header?: string }>();
const visible = defineModel<boolean>({ required: true });
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
        <div class="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line" aria-hidden="true" />
        <div v-if="header" class="shrink-0 px-4 pb-1 pt-3 text-sm font-semibold text-content">{{ header }}</div>
<!-- THE ONE SCROLLER IN THE SHEET. It must be the element that overflows: `overscroll-behavior: contain` on a scroll
     container that cannot scroll swallows the finger instead of chaining to whatever can, which is how every tall
     sheet (model picker, chats) stopped moving under touch while the Drawer's own content box held the overflow. -->
        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2" style="overscroll-behavior: contain">
            <slot />
        </div>
    </Drawer>
</template>
