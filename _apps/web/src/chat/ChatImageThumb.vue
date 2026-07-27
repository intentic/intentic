<script setup lang="ts">
import { ref } from "vue";
import { useChatPopout } from "../composables/chat/useChatPopout";

/* A compact image-attachment thumbnail that reveals a large floating preview on hover — shared by the
 * composer's staged chips and the sent user bubble so both read the same. The preview teleports to the overlay
 * target (the pip body while the chat is popped out, else <body>) so it escapes the chat scroller's
 * overflow-auto clipping. It sits beside the thumb — preferring the side with more room, which is the left for
 * the right-docked chat — so it fills that space instead of covering the transcript. */

withDefaults(defineProps<{ src: string; alt: string; size?: string }>(), { size: `h-9 w-9` });

const { overlayTarget } = useChatPopout();

// Fixed-position band for the floating preview, recomputed from the thumb's rect each time it opens; undefined
// while hidden. The band spans the window's usable height and the free space on one side of the thumb; the image
// is centred inside it and scaled to fit.
const box = ref<{ left?: number; right?: number; width: number; alignRight: boolean }>();

const MARGIN = 16; // px — breathing room against the window edges.
const GAP = 12; // px — between the thumb and the preview.
const MIN_WIDTH = 240; // px — below this a side is too cramped to be worth preferring.
const MAX_WIDTH = 900; // px — cap so the preview stays a preview on very wide windows.

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
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, alignRight ? leftRoom : rightRoom));
    box.value = alignRight ? { right: win.innerWidth - rect.left + GAP, width, alignRight } : { left: rect.right + GAP, width, alignRight };
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
        <div
            v-if="box"
            class="pointer-events-none fixed z-50 flex items-center"
            :class="box.alignRight ? `justify-end` : `justify-start`"
            :style="{
                top: `${MARGIN}px`,
                bottom: `${MARGIN}px`,
                width: `${box.width}px`,
                ...(box.left !== undefined ? { left: `${box.left}px` } : {}),
                ...(box.right !== undefined ? { right: `${box.right}px` } : {}),
            }"
        >
            <img :src="src" :alt="alt" class="max-h-full max-w-full rounded-lg border border-line-strong bg-card object-contain shadow-2xl" />
        </div>
    </Teleport>
</template>
