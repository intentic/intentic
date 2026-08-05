<!-- Inline info affordance: a small (i) icon that reveals a richly formatted card on hover/focus. Purely
     presentational — the card body is projected via <slot>, so each call site supplies its own heading/
     bullets/accents. The card is teleported to <body> and positioned with `position: fixed` from the
     trigger's rect, so it escapes ancestor `overflow` clipping (e.g. the workspace scroll column) and the
     rail — it always paints on top and clamps into the viewport regardless of where the icon sits. Keyboard
     accessible: the icon is focusable and Tab reveals the card (focusin), which is why show/hide is wired
     explicitly — Teleport breaks the CSS group-hover/focus-within chain. The surface uses the role tokens,
     so it tracks light/dark like every other card. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, reactive, ref } from "vue";

// `text` renders a small visible label next to the icon — use it when the hint carries content
// users shouldn't have to discover by hovering a bare (i).
const { label, text = `` } = defineProps<{ label: string; text?: string }>();

const CARD_WIDTH = 288; // w-72
const GAP = 8; // matches the old mt-2

const trigger = ref<HTMLElement>();
const card = ref<HTMLElement>();
const open = ref(false);
const pos = reactive({ top: 0, left: 0 });

/* KEEP THE WHOLE CARD ON SCREEN, which needs its rendered HEIGHT and therefore cannot be done in one pass — the
 * content is a slot, so nothing here knows how tall it is until it exists. This is the measured flip-above the
 * original placement left as a note: it opened downward unconditionally on the assumption that every hint sits
 * near the top of its section, and a hint low in a long page simply ran off the bottom.
 *
 * The horizontal position needs no measurement, so the first pass already lands the card in its final column and
 * only the vertical correction can move it; a card that fits — the common case — is never corrected at all and
 * there is nothing to see.
 *
 * A card taller than the viewport pins to the top and is allowed to overflow the bottom rather than being
 * scrolled: it is pointer-events-none, so an inner scrollbar would be unreachable, and the opening lines are the
 * ones worth guaranteeing. */
const clampVertically = (triggerRect: DOMRect) => {
    const height = card.value?.getBoundingClientRect().height;
    if (height === undefined) {
        return;
    }
    // Flipping above buys real room; sliding up merely moves the card over the trigger it belongs to. Only worth
    // it when the card actually fits up there.
    if (pos.top + height > window.innerHeight - GAP && triggerRect.top - GAP - height >= GAP) {
        pos.top = triggerRect.top - GAP - height;
        return;
    }
    pos.top = Math.max(GAP, Math.min(pos.top, window.innerHeight - height - GAP));
};

/* Below the icon, left edges aligned → opens rightward + down.
 *
 * Deliberately NOT "beside the trigger", which is the obvious repair for a card that covers what is under it and
 * does not work: the trigger is a 16px inline icon, so its own right edge is somewhere in the middle of whatever
 * row it sits in, and a card placed there lands on the same content by a different route. Anything that reaches
 * for the container instead has to guess which ancestor is the container. A hint that would cover a form belongs
 * IN the layout — a column of its own where there is room for one (SetupRunDetails, CredentialGuide) — rather
 * than in an overlay placed cleverly. */
const place = () => {
    const el = trigger.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    pos.top = r.bottom + GAP;
    pos.left = Math.min(Math.max(GAP, r.left), window.innerWidth - CARD_WIDTH - GAP);
    clampVertically(r);
};

// Capture phase: the scroll container is <main>, not window, so a bubbling/window listener won't fire.
const reposition = () => place();

const show = () => {
    place();
    open.value = true;
    // The card exists only now, so this is the first moment its height can be read (see clampVertically).
    void nextTick(() => {
        const el = trigger.value;
        if (el && open.value) {
            clampVertically(el.getBoundingClientRect());
        }
    });
    window.addEventListener(`scroll`, reposition, true);
    window.addEventListener(`resize`, reposition);
};

const hide = () => {
    open.value = false;
    window.removeEventListener(`scroll`, reposition, true);
    window.removeEventListener(`resize`, reposition);
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
        <Teleport to="body">
            <span
                v-if="open"
                ref="card"
                role="tooltip"
                class="pointer-events-none fixed z-50 w-72"
                :style="{ top: `${pos.top}px`, left: `${pos.left}px` }"
            >
                <span class="block rounded-xl border border-line-strong bg-overlay p-4 text-left shadow-xl shadow-black/30">
                    <slot />
                </span>
            </span>
        </Teleport>
    </span>
</template>
