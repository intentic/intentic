import { computed, ref, type ComputedRef } from "vue";
import { holdPreferenceWrites } from "./preference.js";

// WHILE A RESIZE HANDLE IS DRAGGED, EVERY FRAME IS THE DRAG'S. A pane's width moves on every frame of the gesture, and
// whatever measures the pane (an editor re-wrapping a long file, a composer measuring its box, a board folding at a
// breakpoint, a terminal reflowing its buffer) did its work on each of those frames: measured in the editor beside a
// docked chat, that work, not the drag itself, was most of what dropped frames. Such work waits for the gesture through
// `afterResize`, and runs once the pointer rests or lets go. The gesture also holds back preference writes, so a width
// dragged through sixty values is stored and told to the other windows once.

// How long the pointer stays still mid-drag before the work it held back catches up with the size on screen.
export const RESIZE_REST_MS = 150;

const gestures = ref(0);
const waiting = new Set<() => void>();
let rest: ReturnType<typeof setTimeout> | undefined;

/** True while any resize handle is being dragged. */
export const layoutResizing: ComputedRef<boolean> = computed(() => gestures.value > 0);

// Runs everything waiting, each once, in the order it asked; one that throws does not keep the rest from running.
const catchUp = (): void => {
    clearTimeout(rest);
    rest = undefined;
    const due = [...waiting];
    waiting.clear();
    let failure: unknown;
    for (const run of due) {
        try {
            run();
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure !== undefined) {
        throw failure;
    }
};

/**
 * Work that follows a pane's size: run now, unless a resize handle is being dragged, in which case it runs once, when
 * the pointer rests (`RESIZE_REST_MS`) or lets go. Asked again while it waits, the same function still runs once.
 * Returns what takes it back off the wait (an unmounting caller's), a no-op once it has run.
 */
export const afterResize = (run: () => void): (() => void) => {
    if (gestures.value === 0) {
        run();
        return () => {};
    }
    waiting.add(run);
    return () => {
        waiting.delete(run);
    };
};

/** Says the pointer moved mid-gesture: the rest that lets waiting work catch up starts over. */
export const noteResizeMove = (): void => {
    if (gestures.value === 0) {
        return;
    }
    clearTimeout(rest);
    rest = setTimeout(catchUp, RESIZE_REST_MS);
};

/**
 * Starts a resize gesture; the returned function ends it (a second call does nothing). The work it held back runs on
 * the tick after the last gesture ends, once whatever the release committed has been drawn, so it measures the size the
 * reader let go at rather than the frame before it.
 */
export const beginResizeGesture = (): (() => void) => {
    gestures.value += 1;
    const releaseWrites = holdPreferenceWrites();
    let ended = false;
    return () => {
        if (ended) {
            return;
        }
        ended = true;
        gestures.value -= 1;
        releaseWrites();
        if (gestures.value === 0) {
            clearTimeout(rest);
            rest = undefined;
            // A promise rather than Vue's nextTick, which this file need not know: it resolves after the scheduler's
            // own microtask, which the commit queued first.
            void Promise.resolve().then(catchUp);
        }
    };
};
