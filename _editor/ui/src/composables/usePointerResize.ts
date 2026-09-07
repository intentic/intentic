import { ref, type Ref } from "vue";

/* A DRAG THAT RESIZES SOMETHING, written once for the five handles in the app that are one.
 *
 * The chat panel's left edge, the terminal's top edge, the workspace explorer's divider, the review list's
 * divider and the agent rail's right edge are the same gesture pointed at five different setters, and each of
 * them carried its own copy of it. The bodies were byte-identical for `end` in all five and differed only in
 * where the pointer's distance was measured FROM in `move` — which is the only part that is genuinely each
 * surface's own, and is what stays at the call site as `onMove`.
 *
 * POINTER CAPTURE IS THE WHOLE POINT, and the reason this is not four lines anybody can retype. A resize
 * handle is a few pixels wide; without capture the pointer leaves it on the first fast drag and the element
 * stops hearing `pointermove` mid-gesture, which reads as the divider sticking. Capture routes every move and
 * the release to the handle regardless of where the pointer actually is.
 *
 * AND RELEASING IT IS CONDITIONAL, which is the part a hand-written copy gets wrong. `pointerup` and
 * `pointercancel` can both fire for one gesture, and the browser has ALREADY released the capture before it
 * dispatches `pointercancel`; calling `releasePointerCapture` for a pointer the element no longer holds throws
 * `NotFoundError`. Hence the `hasPointerCapture` guard, and the `resizing` latch that makes a second `end` for
 * the same gesture a no-op rather than a second teardown. */

export interface PointerResize {
    /** True for the duration of a drag. Bound in the template, usually as an `is-resizing` class that suppresses
     *  selection and lights the handle. */
    readonly resizing: Ref<boolean>;
    /** `@pointerdown` */
    readonly start: (event: PointerEvent) => void;
    /** `@pointermove` */
    readonly move: (event: PointerEvent) => void;
    /** `@pointerup` and `@pointercancel` */
    readonly end: (event: PointerEvent) => void;
}

/**
 * Wire a resize handle.
 *
 * @param onMove What this surface does with the pointer, called only while a drag is live.
 * @param onStart Read anything the move needs that is only true at the START of the gesture — the edge the
 * width is measured from, which moves during the drag if it is read per move, or the pointer's own position,
 * which <ResizeSeam> subtracts from every later move so it can report a SIZE rather than a coordinate. It is
 * handed the pointerdown event for that second case; a callback that wants neither can still take none.
 */
export function usePointerResize(onMove: (event: PointerEvent) => void, onStart?: (event: PointerEvent) => void): PointerResize {
    const resizing = ref(false);

    return {
        resizing,
        start: (event) => {
            // Or the browser starts a text selection / native drag under the handle instead of a resize.
            event.preventDefault();
            onStart?.(event);
            resizing.value = true;
            (event.target as HTMLElement).setPointerCapture(event.pointerId);
        },
        move: (event) => {
            if (!resizing.value) {
                return;
            }
            onMove(event);
        },
        end: (event) => {
            if (!resizing.value) {
                return;
            }
            resizing.value = false;
            const target = event.target as HTMLElement;
            if (target.hasPointerCapture(event.pointerId)) {
                target.releasePointerCapture(event.pointerId);
            }
        },
    };
}
