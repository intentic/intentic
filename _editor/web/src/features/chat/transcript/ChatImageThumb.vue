<script setup lang="ts">
import { ref } from "vue";

/* A compact image-attachment thumbnail that reveals a large floating preview on hover: shared by the
 * composer's staged chips and the sent user bubble so both read the same. The preview teleports to the overlay
 * target (the pop-out body while the chat is popped out, else <body>) so it escapes the chat scroller's
 * overflow-auto clipping. Sideways it hangs off the whole chat panel's nearer edge (the left, for the right-docked
 * chat, so the transcript stays visible) rather than off the thumb's, which keeps placement independent of where in
 * a row the thumb happens to sit; vertically it is flush with the thumb's own nearer edge. Then it grows as large
 * as that quadrant allows. See show() for the floating fallback. */

withDefaults(defineProps<{ src: string; alt: string; size?: string }>(), { size: `h-9 w-9` });

// The preview's fixed-position corner (one horizontal + one vertical offset) plus how far it may grow from there,
// recomputed from the thumb's rect each time it opens; undefined while hidden.
const box = ref<{ left?: number; right?: number; top?: number; bottom?: number; maxWidth: number; maxHeight: number }>();

const MARGIN = 16; // px: breathing room against the window edges.
const GAP = 12; // px: between the thumb and the preview.
const MIN_WIDTH = 240; // px: below this a side is too cramped to be worth preferring.
const MAX_WIDTH = 900; // px: cap so the preview stays a preview on very wide windows.
const MIN_HEIGHT = 160; // px: floor for the same reason, vertically.

// How much room a box leaves either side of it, once the gap and the window margin are paid for.
const gutters = (rect: DOMRect, viewportWidth: number): [left: number, right: number] => [
    rect.left - GAP - MARGIN,
    viewportWidth - rect.right - GAP - MARGIN,
];

const show = (event: MouseEvent): void => {
    const el = event.currentTarget as HTMLElement;
    // The thumb may live in the floating window, whose viewport (and fixed-position origin) is its own: measure and
    // clamp against that window, not the main realm's globalThis.
    const win = el.ownerDocument.defaultView ?? globalThis;
    const rect = el.getBoundingClientRect();
    // Hang the preview off the CHAT PANEL's edge whenever the window has room beside it. That space is workspace by
    // definition, so the preview covers nothing belonging to the thing it previews, and, being measured from the
    // panel, it opens in the same place whether the thumb is a composer chip on the right or a sent attachment on
    // the left of its prompt. Keying off the thumb's own rect made placement move with the thumb, which is how a
    // left-hand thumbnail ends up throwing its preview rightwards over the very prompt it illustrates.
    // Popped out (or docked near full-bleed) the panel IS the window and there is no gutter to hang off; the thumb
    // is then the only reference left, and the same preference below opens the preview away from the bubble.
    const panel = el.closest(`.chat-panel`)?.getBoundingClientRect();
    const anchor = panel && Math.max(...gutters(panel, win.innerWidth)) >= MIN_WIDTH ? panel : rect;
    const [leftRoom, rightRoom] = gutters(anchor, win.innerWidth);
    // Prefer the left: the chat docks right by default, so the space left of it is the one that isn't transcript.
    // A left-docked panel has nothing that side and falls through to the right.
    const alignRight = leftRoom >= MIN_WIDTH || leftRoom >= rightRoom;
    const maxWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, alignRight ? leftRoom : rightRoom));
    // Vertically the thumb stays the reference either way: the preview has to read as coming out of the image the
    // pointer is on, and the panel's full height says nothing about where in the transcript that is.
    // Flush with the thumb's bottom edge and growing up (the composer sits low), or with its top edge growing down
    // for a thumb near the top of the transcript: whichever direction has more room.
    const upRoom = rect.bottom - MARGIN;
    const growUp = upRoom >= win.innerHeight - rect.top - MARGIN;
    const maxHeight = Math.max(MIN_HEIGHT, growUp ? upRoom : win.innerHeight - rect.top - MARGIN);
    box.value = {
        ...(alignRight ? { right: win.innerWidth - anchor.left + GAP } : { left: anchor.right + GAP }),
        ...(growUp ? { bottom: win.innerHeight - rect.bottom } : { top: rect.top }),
        maxWidth,
        maxHeight,
    };
};
const hide = (): void => {
    box.value = undefined;
};
</script>

<template>
    <img
        :src="src"
        :alt="alt"
        :class="size"
        class="shrink-0 cursor-zoom-in rounded border border-line object-cover"
        @mouseenter="show"
        @mouseleave="hide"
    />
    <Teleport to="body">
        <img
            v-if="box"
            :src="src"
            :alt="alt"
            class="pointer-events-none fixed z-50 rounded-lg border border-line-strong bg-card object-contain shadow-2xl"
            :style="{
                maxWidth: `${box.maxWidth}px`,
                maxHeight: `${box.maxHeight}px`,
                ...(box.left !== undefined ? { left: `${box.left}px` } : {}),
                ...(box.right !== undefined ? { right: `${box.right}px` } : {}),
                ...(box.top !== undefined ? { top: `${box.top}px` } : {}),
                ...(box.bottom !== undefined ? { bottom: `${box.bottom}px` } : {}),
            }"
        />
    </Teleport>
</template>
