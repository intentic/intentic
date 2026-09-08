<!--
    Inline (i) affordance revealing a hover/focus card, teleported and positioned via placeAnchored so it escapes ancestor overflow clipping. Not
    <AnchoredOverlay>: this is a hover card, not a dismissable dialog.
-->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, reactive, ref } from "vue";
import { placeAnchored } from "../../lib/anchorPlacement.js";

// Visible label beside the icon; use when content shouldn't be discoverable only by hovering.
const { label, text = `` } = defineProps<{ label: string; text?: string }>();

const CARD_WIDTH = 288; // Must match the template's `w-72`.
const GAP = 8;
const EDGE = 8;

const trigger = ref<HTMLElement>();
const card = ref<HTMLElement>();
const open = ref(false);
const pos = reactive({ top: 0, left: 0 });

// Placement's height comes from the rendered card, so this can't happen in one pass; placeAnchored handles flip/clamp,
// this handles the slide. A too-tall card pins to the top and overflows the bottom rather than mis-measuring.
const place = (): void => {
    const el = trigger.value;
    const view = el?.ownerDocument.defaultView;
    if (el === undefined || view === null || view === undefined) {
        return;
    }
    const rect = el.getBoundingClientRect();
    // Height is 0 before the card renders; the first pass sets the column, a second settles the row after nextTick.
    const height = card.value?.getBoundingClientRect().height ?? 0;
    const placement = placeAnchored({
        anchor: rect,
        box: { width: CARD_WIDTH, height },
        view: { width: view.innerWidth, height: view.innerHeight },
        side: `bottom`,
        cross: `start`,
        gap: GAP,
        edge: EDGE,
    });
    pos.left = placement.left;
    pos.top = height === 0 ? placement.top : Math.max(EDGE, Math.min(placement.top, view.innerHeight - height - EDGE));
};

// Listener pair while the card is up, remembered by doc/view so it disarms even after the trigger moves away.
let armed: { readonly doc: Document; readonly view: Window } | undefined;

const disarm = (): void => {
    if (armed === undefined) {
        return;
    }
    // Capture phase: the scroll container is <main>, not the window, so a bubbling listener would not fire.
    armed.doc.removeEventListener(`scroll`, place, true);
    armed.view.removeEventListener(`resize`, place);
    armed = undefined;
};

const show = (): void => {
    place();
    open.value = true;
    // The card exists only now, so this is the first moment its height can be read.
    void nextTick(() => {
        if (open.value) {
            place();
        }
    });
    disarm();
    const doc = trigger.value?.ownerDocument;
    const view = doc?.defaultView;
    if (doc === undefined || view === null || view === undefined) {
        return;
    }
    doc.addEventListener(`scroll`, place, true);
    view.addEventListener(`resize`, place);
    armed = { doc, view };
};

const hide = (): void => {
    open.value = false;
    disarm();
};

onBeforeUnmount(hide);
</script>

<template>
    <span ref="trigger" class="relative inline-flex" @mouseenter="show" @mouseleave="hide" @focusin="show" @focusout="hide">
        <!-- `-m-1.5 p-1.5`: bigger tap target around the icon at no layout cost; padding is what a tap must land in. -->
        <span class="-m-1.5 inline-flex cursor-help items-center gap-1.5 p-1.5 text-muted transition-colors hover:text-content" tabindex="0">
            <Icon name="info-circle" role="img" :aria-label="label" />
            <span v-if="text" class="text-xs font-medium">{{ text }}</span>
        </span>
        <!-- Teleports into the trigger's document, not necessarily this module's. -->
        <Teleport v-if="trigger !== undefined" :to="trigger.ownerDocument.body">
            <!-- z-[1200], the tooltip tier: a hint inside an overlay (1000) or modal must still paint above it. -->
            <span
                v-if="open"
                ref="card"
                role="tooltip"
                class="pointer-events-none fixed z-[1200] w-72"
                :style="{ top: `${pos.top}px`, left: `${pos.left}px` }"
            >
                <span class="block rounded-xl border border-line-strong bg-overlay p-4 text-left shadow-xl shadow-black/30">
                    <slot />
                </span>
            </span>
        </Teleport>
    </span>
</template>
