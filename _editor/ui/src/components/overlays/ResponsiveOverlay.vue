<!--
    The app's touch swap as one component: an anchored panel on desktop, a <BottomSheet> on phone, behind one `open` flag. Both hosts stay mounted;
    only the content is conditional, so a picker's per-open reset still fires and AnchoredOverlay can measure once rendered.
-->
<script setup lang="ts">
import type { Cross, Side } from "../../lib/anchorPlacement.js";
import { useDevice } from "../../composables/useDevice.js";
import AnchoredOverlay from "./AnchoredOverlay.vue";
import BottomSheet from "../layout/BottomSheet.vue";

const {
    anchor,
    header,
    panelClass = ``,
    side = `top`,
    cross = `start`,
} = defineProps<{
    /** The element the desktop panel hangs off, and the window it opens in. Ignored on mobile. */
    anchor: HTMLElement | undefined;
    /** The sheet's title on mobile. The desktop panel has none: its anchor says what it belongs to. */
    header?: string;
    /** Sizing for the desktop panel only: a sheet is as wide as the phone ("w-[26rem]", "w-80 p-1"). */
    panelClass?: string;
    side?: Side;
    cross?: Cross;
}>();

const open = defineModel<boolean>({ required: true });
const { mobile } = useDevice();
</script>

<template>
    <BottomSheet v-if="mobile" v-model="open" :header="header">
        <slot v-if="open" />
    </BottomSheet>
    <AnchoredOverlay v-else v-model="open" :anchor="anchor" :side="side" :cross="cross">
        <div class="flex min-h-0 flex-col" :class="panelClass">
            <slot v-if="open" />
        </div>
    </AnchoredOverlay>
</template>
