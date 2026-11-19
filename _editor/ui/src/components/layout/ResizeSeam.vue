<!-- The drag strip between two panes that resizes one of them, via usePointerResize: pointer capture rather than window listeners. -->
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
    preview,
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
    /**
     * Draws the size while it is dragged, in place of the model: called once a frame with the size the pointer asks for,
     * then with `undefined` once the drag has ended and the model holds where it let go, which is the model's only write.
     * For a pane whose size is drawn by something that redraws a lot around it (the shell's grid): the drag then moves
     * the pane and nothing else. Without it the model itself is written, once a frame.
     */
    preview?: (size: number | undefined) => void;
}>();

const size = defineModel<number>({ required: true });

let origin = 0;
let began = 0;
// The size the pointer last asked for; the frame that will draw it, so a burst of moves draws once; and the size last
// written to the model, which a parent's v-model hands back only once it has redrawn, so the model is no witness to it.
let asked: number | undefined;
let frame = 0;
let written = 0;
// The preview the drag started with, which sees it through to its release: one swapped out mid-drag (the pane changed
// arrangement under the pointer) would otherwise never be told the drag ended, and draw its last size for good.
let previewing: typeof preview;

const clamp = (px: number): number => Math.min(max, Math.max(min, px));

const along = (event: PointerEvent): number => (axis === `x` ? event.clientX : event.clientY);

// Pointer moves arrive faster than frames, and each write lays the page out: only the newest move is drawn, once a frame.
const draw = (): void => {
    frame = 0;
    if (asked === undefined) {
        return;
    }
    if (previewing === undefined) {
        written = asked;
        size.value = asked;
        return;
    }
    previewing(asked);
};

// usePointerResize owns text selection, capture, and safe double-release; this adds only the seam's arithmetic.
const {
    resizing,
    start,
    move,
    end: endPointer,
} = usePointerResize(
    (event) => {
        const moved = along(event) - origin;
        asked = clamp(began + (pane === `before` ? moved : -moved));
        frame ||= requestAnimationFrame(draw);
    },
    (event) => {
        origin = along(event);
        began = size.value;
        written = began;
        asked = undefined;
        previewing = preview;
        // Document takes the seam's cursor and stops selecting text for the drag; capture only keeps events here.
        document.body.style.cursor = axis === `x` ? `col-resize` : `row-resize`;
        document.body.style.userSelect = `none`;
    },
);

const releaseDocument = (): void => {
    document.body.style.cursor = ``;
    document.body.style.userSelect = ``;
};

// Where the pointer let go becomes the model's, before the gesture ends: the preferences the gesture held are then
// written with it, and the work it held back measures it.
const commit = (): void => {
    cancelAnimationFrame(frame);
    frame = 0;
    const final = asked;
    asked = undefined;
    if (final !== undefined && final !== written) {
        written = final;
        size.value = final;
    }
    const ending = previewing;
    previewing = undefined;
    ending?.(undefined);
};

// Guarded on `resizing` so the cursor is undone once: pointerup then pointercancel both reach here.
const end = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    commit();
    endPointer(event);
    releaseDocument();
};

// A drag interrupted by the pane unmounting must not leave the document uncursored and unselectable, nor a preview drawn.
onBeforeUnmount(() => {
    if (resizing.value) {
        commit();
    }
    releaseDocument();
});

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
    <!-- `between`: 6px to hit, 0px to lay out—the negative margin cancels the width so a seam never moves the panes. -->
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
