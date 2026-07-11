<!-- Inline info affordance: a small (i) icon that reveals a richly formatted card on hover/focus. Purely
     presentational — the card body is projected via <slot>, so each call site supplies its own heading/
     bullets/accents. The card is teleported to <body> and positioned with `position: fixed` from the
     trigger's rect, so it escapes ancestor `overflow` clipping (e.g. the workspace scroll column) and the
     rail — it always paints on top and clamps into the viewport regardless of where the icon sits. Keyboard
     accessible: the icon is focusable and Tab reveals the card (focusin), which is why show/hide is wired
     explicitly — Teleport breaks the CSS group-hover/focus-within chain. The surface uses the role tokens,
     so it tracks light/dark like every other card. -->
<script setup lang="ts">
import { onBeforeUnmount, reactive, ref } from "vue";

// `text` renders a small visible label next to the icon — use it when the hint carries content
// users shouldn't have to discover by hovering a bare (i).
const { label, text = `` } = defineProps<{ label: string; text?: string }>();

const CARD_WIDTH = 288; // w-72
const GAP = 8; // matches the old mt-2

const trigger = ref<HTMLElement>();
const open = ref(false);
const pos = reactive({ top: 0, left: 0 });

const place = () => {
    const el = trigger.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Below the icon, left edges aligned → opens rightward + down.
    // ponytail: downward only — every hint sits near the top of its section, not the viewport bottom.
    //           add a measured flip-above if a future hint ever lands low.
    pos.top = r.bottom + GAP;
    pos.left = Math.min(Math.max(GAP, r.left), window.innerWidth - CARD_WIDTH - GAP);
};

// Capture phase: the scroll container is <main>, not window, so a bubbling/window listener won't fire.
const reposition = () => place();

const show = () => {
    place();
    open.value = true;
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
        <span class="inline-flex cursor-help items-center gap-1.5 text-muted transition-colors hover:text-content" tabindex="0">
            <Icon name="info-circle" role="img" :aria-label="label" />
            <span v-if="text" class="text-xs font-medium">{{ text }}</span>
        </span>
        <Teleport to="body">
            <span v-if="open" role="tooltip" class="pointer-events-none fixed z-50 w-72" :style="{ top: `${pos.top}px`, left: `${pos.left}px` }">
                <span class="block rounded-xl border border-line-strong bg-overlay p-4 text-left shadow-xl shadow-black/30">
                    <slot />
                </span>
            </span>
        </Teleport>
    </span>
</template>
