<!-- The app's touch swap as one component: an anchored panel on desktop, a <BottomSheet> on phone, behind one `open` flag. -->
<script setup lang="ts">
import { useId } from "vue";
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
    padded = false,
    titled = false,
} = defineProps<{
    /** The element the desktop panel hangs off, and the window it opens in. Ignored on mobile. */
    anchor: HTMLElement | undefined;
    /** The sheet's title on mobile. The desktop panel has none unless `titled`: its anchor says what it belongs to. */
    header?: string;
    /** Sizing for the desktop panel only: a sheet is as wide as the phone ("w-[26rem]", "w-80 p-1"). Inset is `padded`'s. */
    panelClass?: string;
    side?: Side;
    cross?: Cross;
    /** What it holds is a form or a note, not a list of rows that carry their own inset: the content stands 16px in on
     *  both, from the panel's edge and from the sheet's, where a sheet otherwise insets 8px for its menu rows. Inset in
     *  `panelClass` reached the desktop alone, and a phone drew the same form half as far in as the sheet's own title. */
    padded?: boolean;
    /** The desktop panel heads itself with `header` too, as a phone's sheet always does: for a surface opened from a value
     *  rather than from a button that names it. The one heading, drawn by whichever surface is up, so no caller writes
     *  its own and hides it on a phone (the sheet's title above a copy of itself was the result when one forgot). */
    titled?: boolean;
}>();

const open = defineModel<boolean>({ required: true });
const { mobile } = useDevice();
// The heading's id, whichever surface draws it, for content that names a group after it (`aria-labelledby`).
const titleId = useId();
</script>

<template>
    <BottomSheet v-if="mobile" v-model="open" :header="header" :header-id="titleId">
        <!-- 8px more on the sheet's own 8px, so a form lines up with the title over it. -->
        <div v-if="open && padded" class="px-2 pb-2">
            <slot :title-id="header === undefined ? undefined : titleId" />
        </div>
        <slot v-else-if="open" :title-id="header === undefined ? undefined : titleId" />
    </BottomSheet>
    <AnchoredOverlay v-else v-model="open" :anchor="anchor" :side="side" :cross="cross">
        <div class="flex min-h-0 flex-col" :class="[panelClass, padded && `p-4`]">
            <p v-if="titled && header !== undefined" :id="titleId" class="mb-2 text-sm font-semibold text-content">{{ header }}</p>
            <slot v-if="open" :title-id="titled && header !== undefined ? titleId : undefined" />
        </div>
    </AnchoredOverlay>
</template>
