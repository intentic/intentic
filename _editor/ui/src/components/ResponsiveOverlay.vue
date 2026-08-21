<!-- THE APP'S STANDARD TOUCH SWAP, as one component: a panel anchored to its trigger on desktop, the same panel
     as a thumb-reachable bottom sheet on a phone. <Picker> has always done this internally; every OTHER menu in
     the app wrote the pair out by hand: a `v-if="mobile"` <BottomSheet>, a `v-else` <AnchoredOverlay>, and the
     desktop sizing div between them: five times over the composer's three pills, the suggested-session box and
     the shell's host picker.

     ONE OPEN FLAG, WHICH IS THE POINT AND NOT A CONVENIENCE. A hand-written pair invites a boolean each, and
     that is a bug with a long fuse: the two drift, and whatever watches "the menu", a close-on-disconnect, a
     close-when-the-trigger-greys: reaches only the half it was written against. The suggested-session box had
     grown exactly that pair. Here there is one flag and nothing to keep in step.

     THE HOSTS STAY MOUNTED and `open` drives them; only the CONTENT is conditional. That is load-bearing.
     AnchoredOverlay measures and places its box in a watcher on `open` that is deliberately not immediate:
     there is nothing to measure until the box has rendered, so a host mounted with `open` already true never
     places at all and the panel sits parked off-screen, open and invisible. Keeping the content conditional
     still gives it a per-open remount, which is what a picker's reset-query-and-refetch relies on.

     THE ANCHOR DECIDES THE WINDOW, so this works in a popped-out panel with nothing extra passed: AnchoredOverlay
     derives the document it teleports into, the viewport it measures the free room against, and the click that
     must never dismiss it, all from that element. -->
<script setup lang="ts">
import { type Cross, type Side } from "../lib/anchorPlacement.js";
import { useDevice } from "../composables/useDevice.js";
import AnchoredOverlay from "./AnchoredOverlay.vue";
import BottomSheet from "./BottomSheet.vue";

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
