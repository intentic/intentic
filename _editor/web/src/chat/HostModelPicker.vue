<script setup lang="ts">
import { ResponsiveOverlay } from "@intentic/ui";
import { computed } from "vue";
import { modelRequest, settleModelPick } from "../composables/chat/hostModelPicker";
import HostPickerBody from "./HostPickerBody.vue";

/* The app-global mount for the shell's own model picker when something outside the chat asks for one
 * (hostModelPicker.ts — today, an extension calling `api.models.pick()`). Mounted in App.vue rather than in a
 * shell, because the two shells would otherwise each need their own copy and neither is the natural owner: the
 * picker belongs to nothing on screen, it belongs to whoever asked.
 *
 * Same body as the composer's (HostPickerBody), in the app's standard touch swap: an anchored panel on desktop,
 * a sheet on mobile. ResponsiveOverlay owns that swap — including the stay-mounted rule the pair depends on,
 * which used to be spelled out here. The body is a component rather than markup repeated under each host — it
 * carries a footer now, and two copies of it are two places for the two surfaces to drift apart. */

// One boolean over the request, so the overlay's own dismissal (pointerdown outside, Escape, the sheet's
// backdrop) settles the promise as a dismissal rather than silently orphaning it.
const open = computed<boolean>({
    get: () => modelRequest.value !== undefined,
    set: (value) => {
        if (!value) {
            settleModelPick(undefined);
        }
    },
});
</script>

<template>
    <ResponsiveOverlay v-model="open" :anchor="modelRequest?.anchor" header="Model" panel-class="w-[26rem]">
        <HostPickerBody />
    </ResponsiveOverlay>
</template>
