<!-- THE DRAG SEAM: the strip between two panes that sizes one of them.

     IT IS IN THE KIT BECAUSE IT WAS WRITTEN FIVE TIMES. The workspace explorer, the terminal panel, the chat
     panel, the agents rail and the agent review list each grew their own: same 6px strip, same pointer-capture
     drag, same `is-resizing` tint, same double-click reset, five slightly different spellings of each. And the
     sixth caller (the workflow designer, which lives in an EXTENSION) could not have reached any of them. That
     is the same fault <SplitView> was extracted for: the one implementation that had solved a shape sat in the
     web app, where the code that needed it next could not import it.

     ALL SIX NOW CALL THIS, which is worth saying because for a while they did not: the component was extracted
     and the copies were left standing, so the kit held the answer and every surface still shipped its own. The
     drift the migration turned up was in the two places this file already claims are hard. Four of the five
     measured a pane's rect at pointer-down and one read the raw viewport width; each was right for its own
     layout and none was right in general, which is why what is reported here is a size. And all five suppressed
     text selection only within their OWN subtree, so a drag that outran the panel — and every drag does — went
     on highlighting whatever it crossed outside it. The cursor and the selection are the document's for the
     length of a drag, so they are taken on `document.body` here.

     POINTER CAPTURE, NOT WINDOW LISTENERS, and it is `usePointerResize` that does it rather than this file. A
     drag that outruns the strip (and every drag does: the pointer leaves a 6px target in the first frame) still
     tracks, because the events keep coming to the seam itself. Nothing is bound to the window, so nothing has
     to be unbound. That composable was extracted for the five call sites this component then replaced, which
     leaves one consumer and no copies — the drag mechanics in one place, the seam that draws them in another.

     IT REPORTS A SIZE, NOT A POSITION. Reading the pane's rect at every move is what made two of the four
     copies subtly different: one measured the pane, one used the raw viewport coordinate, and each was right
     only for its own layout. The size at pointer-down plus the distance dragged since is neither: it is
     correct wherever the seam sits, in a pop-out window as much as in the page. `pane` says which side of the
     seam the pane being sized is on, and that is the whole of the geometry. -->
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
    /** WHERE THE STRIP SITS, which is a fact about the layout around it rather than a taste.
     *
     *  `between` is the seam proper: an in-flow item on the axis two panes are laid out along, taking 6px to hit
     *  and giving them back with a negative margin, so adding one never moves either pane. Prefer it — a seam in
     *  flow cannot be scrolled away from the border it marks.
     *
     *  `edge` is the overlay, for the pane whose OWN axis runs the other way: the docked chat is a column of a
     *  bar and its panes, and a seam on its left edge has no position in that column to be in flow at. It is
     *  positioned against the nearest positioned ancestor, so the pane it rides must be `relative`. */
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

/* THE DRAG MECHANICS ARE usePointerResize'S, and only the arithmetic above them is this component's. That
 * composable owns the three things a hand-written handle gets wrong — preventing the browser's own text
 * selection, pointer capture so a drag that outruns a 6px strip keeps tracking, and releasing that capture
 * ONLY when the element still holds it, since `pointerup` and `pointercancel` can both fire for one gesture
 * and the second release throws. It was extracted for the five copies of this that used to live at the call
 * sites; those five now draw this component instead, so this is where it belongs.
 *
 * What stays here is the part that is a SEAM's rather than a drag's: the pointer's position at pointerdown and
 * the size the pane had then, so every later move reports `began + distance` — a size, not a coordinate. */
const { resizing, start, move, end: endPointer } = usePointerResize(
    (event) => {
        const moved = along(event) - origin;
        size.value = clamp(began + (pane === `before` ? moved : -moved));
    },
    (event) => {
        origin = along(event);
        began = size.value;
        /* For the duration of the drag the whole document takes the seam's cursor and stops selecting text.
         * Pointer capture keeps the EVENTS here; it does not stop the pointer from looking like a caret over
         * the prose it is passing across, and a drag that highlights half the panel it is resizing reads as a
         * bug. The composable has no `onEnd`, so the undo is wrapped around its `end` below. */
        document.body.style.cursor = axis === `x` ? `col-resize` : `row-resize`;
        document.body.style.userSelect = `none`;
    },
);

const releaseDocument = (): void => {
    document.body.style.cursor = ``;
    document.body.style.userSelect = ``;
};

/* Guarded on `resizing` BEFORE delegating, so the document's cursor is undone exactly once per gesture: a
 * `pointerup` followed by a `pointercancel` reaches here twice, and the composable's own `end` is already a
 * no-op the second time. */
const end = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    endPointer(event);
    releaseDocument();
};

// A drag interrupted by the pane unmounting (Back out of the designer mid-drag) must not leave the document
// uncursored and unselectable.
onBeforeUnmount(releaseDocument);

/* WRITTEN OUT, NEVER BUILT. Every one of these is a whole class as Tailwind's scanner will read it: composing
 * them (`w-${…}`, `inset-${…}-0`) is the failure the kit's README names, where the class is generated, never
 * seen, and ships as nothing at all — silently, with the element simply rendering unstyled.
 *
 * `edge` derives WHICH edge from the two props that already say it: the seam rides the border on the side the
 * pane is NOT, so a pane `after` the seam is one the seam sits at the leading edge of. */
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
    <!-- In flow (`between`) the strip is 6px to hit and 0px to lay out: the negative margin pulls back exactly
         what the width adds, so adding a seam between two panes never moves either of them. As an overlay
         (`edge`) it costs nothing to begin with, and rides the pane's own border instead. -->
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
