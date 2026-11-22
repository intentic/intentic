<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";

const t = useT();
const focusContent = (): void => {
    document.getElementById(`main-content`)?.focus();
};
</script>

<template>
    <!-- The shadow only once it is in view: parked above the window, `shadow-lg` reached 20px down past its top edge and
         drew a grey smudge over every screen's top bar. -->
    <a
        href="#main-content"
        class="fixed left-3 top-3 z-100 -translate-y-[calc(100%+1rem)] rounded-md bg-card px-4 py-3 font-medium text-content focus:translate-y-0 focus:shadow-lg"
        @click.prevent="focusContent"
    >{{ t(`shell.skipToContent`) }}</a>
</template>
