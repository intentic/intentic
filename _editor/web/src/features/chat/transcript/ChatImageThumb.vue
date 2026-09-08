<script setup lang="ts">
import { ref } from "vue";

// Compact image thumbnail with a floating preview on hover, shared by the composer's staged chips and the sent bubble.
// Teleports to the overlay target to escape the chat scroller's clipping, and anchors off the chat panel's nearer edge,
// not the thumb's, so placement doesn't depend on where in a row the thumb sits.

withDefaults(defineProps<{ src: string; alt: string; size?: string }>(), { size: `h-9 w-9` });

// Preview's fixed-position corner and how far it may grow, recomputed from the thumb's rect on each open.
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
    // Thumb may live in a floating window with its own viewport; clamp against that window, not globalThis.
    const win = el.ownerDocument.defaultView ?? globalThis;
    const rect = el.getBoundingClientRect();
    // Prefers the chat panel's edge over the thumb's, so the preview covers workspace, not the thing it previews.
    const panel = el.closest(`.chat-panel`)?.getBoundingClientRect();
    const anchor = panel && Math.max(...gutters(panel, win.innerWidth)) >= MIN_WIDTH ? panel : rect;
    const [leftRoom, rightRoom] = gutters(anchor, win.innerWidth);
    // Prefers left since the chat docks right by default; falls through to right when there's no room.
    const alignRight = leftRoom >= MIN_WIDTH || leftRoom >= rightRoom;
    const maxWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, alignRight ? leftRoom : rightRoom));
    // Vertically anchors to the thumb, not the panel, and grows toward whichever side (up or down) has more room.
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
