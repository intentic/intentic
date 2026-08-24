<!-- Inline info affordance: a small (i) icon that reveals a richly formatted card on hover/focus. Purely
     presentational: the card body is projected via <slot>, so each call site supplies its own heading/
     bullets/accents. The card is teleported out of the flow and positioned from the trigger's rect, so it
     escapes ancestor `overflow` clipping (e.g. the workspace scroll column) and the rail: it always paints on
     top and clamps into the viewport regardless of where the icon sits. Keyboard accessible: the icon is
     focusable and Tab reveals the card (focusin), which is why show/hide is wired explicitly: Teleport breaks
     the CSS group-hover/focus-within chain. The surface uses the role tokens, so it tracks light/dark like
     every other card.

     WHERE IT GOES IS `placeAnchored`'S ANSWER, not this file's. It used to carry its own copy of the flip-above
     and the horizontal clamp, written against the module-scope `window` and teleported to the module-scope
     `document.body`, which is the bug anchorPlacement.ts opens by describing: a hint measured its room against
     one window's viewport and landed in another's. It is the third implementation of that geometry the app had
     (AnchoredOverlay and the tooltip directive were the others), and the only one nobody had noticed was wrong,
     because a hint that opens slightly off is a hint you assume you mis-hovered.

     It does NOT use <AnchoredOverlay>, which owns the same geometry, and that is deliberate: that component is
     a dialog: it dismisses on outside pointerdown, takes Escape, and hands the keyboard back on close. This is
     a hover card. It shares the maths and nothing else. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, reactive, ref } from "vue";
import { placeAnchored } from "../lib/anchorPlacement.js";

// `text` renders a small visible label next to the icon: use it when the hint carries content
// users shouldn't have to discover by hovering a bare (i).
const { label, text = `` } = defineProps<{ label: string; text?: string }>();

const CARD_WIDTH = 288; // w-72
const GAP = 8; // matches the old mt-2
const EDGE = 8;

const trigger = ref<HTMLElement>();
const card = ref<HTMLElement>();
const open = ref(false);
const pos = reactive({ top: 0, left: 0 });

/* KEEP THE WHOLE CARD ON SCREEN, which needs its rendered HEIGHT and therefore cannot be done in one pass: the
 * content is a slot, so nothing here knows how tall it is until it exists. `placeAnchored` flips it above when
 * that buys real room and clamps it horizontally; the one thing left here is the SLIDE, which is this card's
 * own answer rather than the shared one.
 *
 * A panel slides nowhere, it caps its height and scrolls. This cannot: it is pointer-events-none, so an inner
 * scrollbar would be unreachable. So a card that fits in the window but not below its trigger slides up until
 * it does, and a card taller than the window pins to the top edge and overflows the bottom, because the opening
 * lines are the ones worth guaranteeing. */
const place = (): void => {
    const el = trigger.value;
    const view = el?.ownerDocument.defaultView;
    if (el === undefined || view === null || view === undefined) {
        return;
    }
    const rect = el.getBoundingClientRect();
    // Height is 0 until the card has rendered; the first pass therefore lands the column and the second (after
    // nextTick, from show()) settles the row. A card that fits is never corrected and there is nothing to see.
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

// What is armed while the card is up, and on WHICH document: remembered so the same pair is disarmed even
// after the trigger has moved to another window (a panel docking mid-hover) or gone away entirely.
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
    // The card exists only now, so this is the first moment its height can be read (see place).
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
        <!-- `-m-1.5 p-1.5` is a thumb's worth of target around a 16px icon that costs the layout nothing: the
             padding is what a tap has to land in (this element carries the tabindex, and touch opens the card
             by focusing it), and the negative margin gives the space back to the row it sits in. -->
        <span class="-m-1.5 inline-flex cursor-help items-center gap-1.5 p-1.5 text-muted transition-colors hover:text-content" tabindex="0">
            <Icon name="info-circle" role="img" :aria-label="label" />
            <span v-if="text" class="text-xs font-medium">{{ text }}</span>
        </span>
        <!-- Into the TRIGGER's document, which is not this module's when the app has drawn the hint elsewhere. -->
        <Teleport v-if="trigger !== undefined" :to="trigger.ownerDocument.body">
            <!-- THE TOOLTIP TIER (1200), not a page-level z-50, and for the reason tooltip.css states: this is a
                 hover card, so it is raised BY a control, and controls live inside overlays (1000) and modals
                 (1100) as readily as on a page. At z-50 a hint on a control in either one teleported correctly,
                 clamped correctly, and then painted BEHIND the panel that raised it, which looks exactly like a
                 hint that never opened. Nothing in the app sits above this tier. -->
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
