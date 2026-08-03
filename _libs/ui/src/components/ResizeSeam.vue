<!-- THE DRAG SEAM — the strip between two panes that sizes one of them.

     IT IS IN THE KIT BECAUSE IT WAS WRITTEN FOUR TIMES. The workspace explorer, the terminal panel, the chat
     rail and the agent review list each grew their own: same 6px strip, same pointer-capture drag, same
     `is-resizing` tint, same double-click reset, four slightly different spellings of each. And the fifth
     caller — the workflow designer, which lives in an EXTENSION — could not have reached any of them. That is
     the same fault <SplitView> was extracted for: the one implementation that had solved a shape sat in the web
     app, where the code that needed it next could not import it.

     POINTER CAPTURE, NOT WINDOW LISTENERS. A drag that outruns the strip (and every drag does — the pointer
     leaves a 6px target in the first frame) still tracks, because the events keep coming to the seam itself.
     Nothing is bound to the window, so nothing has to be unbound.

     IT REPORTS A SIZE, NOT A POSITION. Reading the pane's rect at every move is what made two of the four
     copies subtly different: one measured the pane, one used the raw viewport coordinate, and each was right
     only for its own layout. The size at pointer-down plus the distance dragged since is neither — it is
     correct wherever the seam sits, in a pop-out window as much as in the page. `pane` says which side of the
     seam the pane being sized is on, and that is the whole of the geometry. -->
<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

const {
    axis = `x`,
    pane = `before`,
    min,
    max,
    reset,
} = defineProps<{
    /** Which way the seam is dragged: `x` sizes a column, `y` sizes a row. */
    axis?: `x` | `y`;
    /** Which side of the seam the pane being sized is on — i.e. which way dragging makes it bigger. */
    pane?: `before` | `after`;
    min: number;
    max: number;
    /** Double-click size. Absent ⇒ double-click does nothing, because there is no size to call the default. */
    reset?: number;
}>();

const size = defineModel<number>({ required: true });

const dragging = ref(false);
let origin = 0;
let began = 0;

const clamp = (px: number): number => Math.min(max, Math.max(min, px));

const start = (event: PointerEvent): void => {
    event.preventDefault();
    origin = axis === `x` ? event.clientX : event.clientY;
    began = size.value;
    dragging.value = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    /* For the duration of the drag the whole document takes the seam's cursor and stops selecting text. Pointer
     * capture keeps the EVENTS here; it does not stop the pointer from looking like a caret over the prose it
     * is passing across, and a drag that highlights half the panel it is resizing reads as a bug. */
    document.body.style.cursor = axis === `x` ? `col-resize` : `row-resize`;
    document.body.style.userSelect = `none`;
};

const move = (event: PointerEvent): void => {
    if (!dragging.value) {
        return;
    }
    const moved = (axis === `x` ? event.clientX : event.clientY) - origin;
    size.value = clamp(began + (pane === `before` ? moved : -moved));
};

const release = (): void => {
    dragging.value = false;
    document.body.style.cursor = ``;
    document.body.style.userSelect = ``;
};

const end = (event: PointerEvent): void => {
    if (!dragging.value) {
        return;
    }
    const target = event.target as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
    }
    release();
};

// A drag interrupted by the pane unmounting (Back out of the designer mid-drag) must not leave the document
// uncursored and unselectable.
onBeforeUnmount(release);
</script>

<template>
    <!-- The strip is 6px to hit and 0px to lay out: the negative margin pulls back exactly what the width adds,
         so adding a seam between two panes never moves either of them. -->
    <div
        role="separator"
        :aria-orientation="axis === `x` ? `vertical` : `horizontal`"
        class="relative z-20 shrink-0 touch-none transition-colors hover:bg-primary-500/35"
        :class="[axis === `x` ? `-mx-[3px] w-1.5 cursor-col-resize` : `-my-[3px] h-1.5 cursor-row-resize`, dragging ? `bg-primary-500/35` : ``]"
        @pointerdown="start"
        @pointermove="move"
        @pointerup="end"
        @pointercancel="end"
        @dblclick="reset !== undefined && (size = reset)"
    ></div>
</template>
