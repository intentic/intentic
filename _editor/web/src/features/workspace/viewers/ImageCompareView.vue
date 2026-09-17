<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";

// Two pictures laid over each other in one pane, for the change two side-by-side panes cannot show: a moved pixel.
// Swipe wipes the after picture over the before one at a handle the reader drags; onion skin fades between them.
// Both pictures are fitted to the pane together, so the same point of two same-sized captures lands on the same spot.

const { before, after, mode } = defineProps<{ before: string; after: string; mode: "swipe" | "onion" }>();

const t = useT();

// Where the handle stands, as a share of the pane's width (swipe) or of the after picture's opacity (onion).
const position = ref(0.5);
// A new pair starts in the middle, where both pictures are half in view.
watch(
    () => [before, after, mode] as const,
    () => {
        position.value = 0.5;
    },
);

const percent = computed(() => Math.round(position.value * 100));

const afterStyle = computed(() =>
    mode === `swipe` ? { clipPath: `inset(0 0 0 ${percent.value}%)` } : { opacity: String(position.value) },
);

// Drag anywhere in the pane: the handle follows the pointer, no slider to aim for.
const pane = ref<HTMLElement>();
let dragging = false;
const moveTo = (clientX: number): void => {
    const rect = pane.value?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) {
        return;
    }
    position.value = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
};
const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
        return;
    }
    event.preventDefault();
    dragging = true;
    pane.value?.setPointerCapture(event.pointerId);
    moveTo(event.clientX);
};
const onPointerMove = (event: PointerEvent): void => {
    if (dragging) {
        moveTo(event.clientX);
    }
};
const onPointerUp = (): void => {
    dragging = false;
};
const onKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 0.1 : 0.02;
    if (event.key === `ArrowLeft`) {
        position.value = Math.max(0, position.value - step);
    } else if (event.key === `ArrowRight`) {
        position.value = Math.min(1, position.value + step);
    } else {
        return;
    }
    event.preventDefault();
};
</script>

<template>
    <div
        ref="pane"
        class="image-checker relative h-full w-full touch-none select-none overflow-hidden outline-none"
        :class="mode === `swipe` ? `cursor-col-resize` : `cursor-ew-resize`"
        tabindex="0"
        role="slider"
        :aria-valuenow="percent"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="mode === `swipe` ? t(`workspace.imageCompareView.swipeBetweenPictures`) : t(`workspace.imageCompareView.fadeBetweenPictures`)"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @keydown="onKeyDown"
    >
        <img :src="before" alt="" draggable="false" class="absolute inset-0 h-full w-full object-contain" />
        <img :src="after" alt="" draggable="false" class="absolute inset-0 h-full w-full object-contain" :style="afterStyle" />
        <!-- The seam, drawn only where there is one to see. -->
        <div v-if="mode === `swipe`" class="pointer-events-none absolute inset-y-0 w-px bg-content/70 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" :style="{ left: `${percent}%` }">
            <span class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line bg-card/90 px-1.5 py-0.5 text-2xs text-muted shadow-sm">⇆</span>
        </div>
        <div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2">
            <span class="rounded-lg border border-line bg-card/90 px-2 py-0.5 text-2xs tabular-nums text-muted shadow-sm backdrop-blur">
                {{ mode === `swipe` ? t(`workspace.imageCompareView.swipeCaption`, { percent }) : t(`workspace.imageCompareView.onionCaption`, { percent }) }}
            </span>
        </div>
    </div>
</template>
