<!-- Mobile action sheet: PrimeVue Drawer docked to the bottom edge with a rounded top, grab handle, and
     safe-area padding. The touch replacement for every Popover/ContextMenu on mobile code paths: pass the
     same content, get a thumb-reachable sheet. Height follows content up to `--height-panel-xl`, the step it
     shares with the fullscreen-canvas modal: both are "as much screen as this may take". -->
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
        :pt="{ header: { class: `!hidden` }, content: { class: `!p-0` } }"
    >
        <div class="mx-auto mt-2 h-1 w-9 rounded-full bg-line" aria-hidden="true" />
        <div v-if="header" class="px-4 pb-1 pt-3 text-sm font-semibold text-content">{{ header }}</div>
        <div class="overflow-y-auto px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2" style="overscroll-behavior: contain">
            <slot />
        </div>
    </Drawer>
</template>
