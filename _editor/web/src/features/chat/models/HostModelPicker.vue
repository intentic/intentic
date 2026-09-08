<script setup lang="ts">
import { ResponsiveOverlay } from "@intentic/ui";
import { computed } from "vue";
import { dismissModelPick, modelRequest } from "./hostModelPicker";
import HostPickerBody from "./HostPickerBody.vue";

// App-global mount for the shell's own model picker when something outside the chat asks for one (hostModelPicker.ts).
// Mounted in App.vue, not a shell, since the picker belongs to whoever asked, not to anything on screen. Same body as
// the composer's (HostPickerBody), a component rather than repeated markup so the two surfaces can't drift apart.

// One boolean over the request, so the overlay's own dismissal (pointerdown outside, Escape, the sheet's
// backdrop) settles the promise rather than silently orphaning it. Every one of those gestures is a CANCEL, in
// full: the panel ends in its own button now, so leaving it by any other route keeps nothing (hostModelPicker).
const open = computed<boolean>({
    get: () => modelRequest.value !== undefined,
    set: (value) => {
        if (!value) {
            dismissModelPick();
        }
    },
});
</script>

<template>
    <ResponsiveOverlay v-model="open" :anchor="modelRequest?.anchor" header="Model" panel-class="w-[26rem]">
        <HostPickerBody />
    </ResponsiveOverlay>
</template>
