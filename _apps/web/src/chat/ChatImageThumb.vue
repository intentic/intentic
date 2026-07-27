<script setup lang="ts">
import { ref } from "vue";
import { useChatPopout } from "../composables/chat/useChatPopout";

/* A compact image-attachment thumbnail that reveals a larger floating preview on hover — shared by the
 * composer's staged chips and the sent user bubble so both read the same. The preview teleports to the overlay
 * target (the pip body while the chat is popped out, else <body>) so it escapes the chat scroller's
 * overflow-auto clipping, and flips above/below the thumb depending on the room in that window. */

withDefaults(defineProps<{ src: string; alt: string; size?: string }>(), { size: `h-9 w-9` });

const { overlayTarget } = useChatPopout();

// Fixed-position box for the floating preview, recomputed from the thumb's rect each time it opens; undefined
// while hidden.
const box = ref<{ left: number; top?: number; bottom?: number }>();

const MAX = 320; // px — matches the preview's max edge (max-h/max-w below).
const GAP = 8;

const show = (event: MouseEvent): void => {
    const el = event.currentTarget as HTMLElement;
    // The thumb may live in the pip window, whose viewport (and fixed-position origin) is its own — measure and
    // clamp against that window, not the main realm's globalThis.
    const win = el.ownerDocument.defaultView ?? globalThis;
    const rect = el.getBoundingClientRect();
    const left = Math.min(Math.max(GAP, rect.left + rect.width / 2 - MAX / 2), win.innerWidth - MAX - GAP);
    // Anchor on whichever side has more room: above for the bottom-docked composer, below for a thumb near the
    // top of the transcript.
    box.value = rect.top >= win.innerHeight - rect.bottom ? { left, bottom: win.innerHeight - rect.top + GAP } : { left, top: rect.bottom + GAP };
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
            class="pointer-events-none fixed z-50 max-h-[20rem] max-w-[20rem] rounded-lg border border-line-strong bg-card object-contain shadow-2xl"
            :style="{
                left: `${box.left}px`,
                ...(box.top !== undefined ? { top: `${box.top}px` } : {}),
                ...(box.bottom !== undefined ? { bottom: `${box.bottom}px` } : {}),
            }"
        />
    </Teleport>
</template>
