<!--
    The drag strip between two panes that resizes one of them, via usePointerResize: pointer capture rather than window listeners, so a fast drag off
    the strip keeps tracking. Reports a size, not a position; `pane` says which side is being sized.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount } from "vue";
import { usePointerResize } from "../../composables/usePointerResize.js";

const {
    axis = `x`,
    pane = `before`,
    place = `between`,
    min,
    max,
    reset,
} = defineProps<{
    /** Which way the seam is dragged: `x` sizes a column, `y` sizes a row. */
    axis?: `x` | `y`;
    /** Which side of the seam the pane being sized is on: i.e. which way dragging makes it bigger. */
    pane?: `before` | `after`;
    /** `between`: in-flow, never moves the panes. `edge`: overlay for the other axis; needs a `relative` ancestor. */
    place?: `between` | `edge`;
    min: number;
    max: number;
    /** Double-click size. Absent ⇒ double-click does nothing, because there is no size to call the default. */
    reset?: number;
}>();

const size = defineModel<number>({ required: true });

let origin = 0;
let began = 0;

const clamp = (px: number): number => Math.min(max, Math.max(min, px));

const along = (event: PointerEvent): number => (axis === `x` ? event.clientX : event.clientY);

// usePointerResize owns text selection, capture, and safe double-release; this adds only the seam's arithmetic.
const { resizing, start, move, end: endPointer } = usePointerResize(
    (event) => {
        const moved = along(event) - origin;
        size.value = clamp(began + (pane === `before` ? moved : -moved));
    },
    (event) => {
        origin = along(event);
        began = size.value;
        // Document takes the seam's cursor and stops selecting text for the drag; capture only keeps events here.
        document.body.style.cursor = axis === `x` ? `col-resize` : `row-resize`;
        document.body.style.userSelect = `none`;
    },
);

const releaseDocument = (): void => {
    document.body.style.cursor = ``;
    document.body.style.userSelect = ``;
};

// Guarded on `resizing` so the cursor is undone once: pointerup then pointercancel both reach here.
const end = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    endPointer(event);
    releaseDocument();
};

// A drag interrupted by the pane unmounting must not leave the document uncursored and unselectable.
onBeforeUnmount(releaseDocument);

// Full literal classes, never composed, so Tailwind's scanner sees them; `edge` derives its side from props.
const SHAPE = {
    "between-x": `relative shrink-0 -mx-0.75 w-1.5 cursor-col-resize`,
    "between-y": `relative shrink-0 -my-0.75 h-1.5 cursor-row-resize`,
    "edge-x-after": `absolute inset-y-0 left-0 w-1.5 cursor-col-resize`,
    "edge-x-before": `absolute inset-y-0 right-0 w-1.5 cursor-col-resize`,
    "edge-y-after": `absolute inset-x-0 top-0 h-1.5 cursor-row-resize`,
    "edge-y-before": `absolute inset-x-0 bottom-0 h-1.5 cursor-row-resize`,
} as const;

const shape = computed<string>(() => (place === `between` ? SHAPE[`between-${axis}`] : SHAPE[`edge-${axis}-${pane}`]));
</script>

<template>
    <!--
        `between`: 6px to hit, 0px to lay out—the negative margin cancels the width so a seam never moves the panes.
        `edge` costs nothing; it rides the pane's own border.
    -->
    <div
        role="separator"
        :aria-orientation="axis === `x` ? `vertical` : `horizontal`"
        class="z-20 touch-none transition-colors hover:bg-primary-500/35"
        :class="[shape, resizing ? `bg-primary-500/35` : ``]"
        @pointerdown="start"
        @pointermove="move"
        @pointerup="end"
        @pointercancel="end"
        @dblclick="reset !== undefined && (size = reset)"
    ></div>
</template>
