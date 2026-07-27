<script setup lang="ts">
import { ref } from "vue";
import { useChatPopout } from "../composables/chat/useChatPopout";

/* A compact image-attachment thumbnail that reveals a large floating preview on hover — shared by the
 * composer's staged chips and the sent user bubble so both read the same. The preview teleports to the overlay
 * target (the pip body while the chat is popped out, else <body>) so it escapes the chat scroller's
 * overflow-auto clipping. It hangs off the thumb's nearest corner — sideways into the roomier side (the left, for
 * the right-docked chat, so the transcript stays visible) and flush with the thumb's nearer horizontal edge — then
 * grows as large as that quadrant allows. */

withDefaults(defineProps<{ src: string; alt: string; size?: string }>(), { size: `h-9 w-9` });

const { overlayTarget } = useChatPopout();

// The preview's fixed-position corner (one horizontal + one vertical offset) plus how far it may grow from there,
// recomputed from the thumb's rect each time it opens; undefined while hidden.
const box = ref<{ left?: number; right?: number; top?: number; bottom?: number; maxWidth: number; maxHeight: number }>();

const MARGIN = 16; // px — breathing room against the window edges.
const GAP = 12; // px — between the thumb and the preview.
const MIN_WIDTH = 240; // px — below this a side is too cramped to be worth preferring.
const MAX_WIDTH = 900; // px — cap so the preview stays a preview on very wide windows.
const MIN_HEIGHT = 160; // px — floor for the same reason, vertically.

const show = (event: MouseEvent): void => {
    const el = event.currentTarget as HTMLElement;
    // The thumb may live in the pip window, whose viewport (and fixed-position origin) is its own — measure and
    // clamp against that window, not the main realm's globalThis.
    const win = el.ownerDocument.defaultView ?? globalThis;
    const rect = el.getBoundingClientRect();
    const leftRoom = rect.left - GAP - MARGIN;
    const rightRoom = win.innerWidth - rect.right - GAP - MARGIN;
    // Prefer the left: the chat is docked right, so the space left of the thumb is the one that isn't transcript.
    const alignRight = leftRoom >= MIN_WIDTH || leftRoom >= rightRoom;
    const maxWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, alignRight ? leftRoom : rightRoom));
    // Flush with the thumb's bottom edge and growing up (the composer sits low), or with its top edge growing down
    // for a thumb near the top of the transcript — whichever direction has more room.
    const upRoom = rect.bottom - MARGIN;
    const growUp = upRoom >= win.innerHeight - rect.top - MARGIN;
    const maxHeight = Math.max(MIN_HEIGHT, growUp ? upRoom : win.innerHeight - rect.top - MARGIN);
    box.value = {
        ...(alignRight ? { right: win.innerWidth - rect.left + GAP } : { left: rect.right + GAP }),
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
    <Teleport :to="overlayTarget">
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
