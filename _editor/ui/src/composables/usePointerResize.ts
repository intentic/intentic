import { ref, type Ref } from "vue";

// Shared resize-handle gesture used by five drag handles in the app. Pointer capture keeps a fast drag tracked even
// when the pointer leaves the handle. releasePointerCapture is guarded because pointercancel already releases
// capture before dispatching, and the `resizing` latch makes a repeated end a no-op.

export interface PointerResize {
    /** True for the duration of a drag; bind as `is-resizing` to suppress selection and light the handle. */
    readonly resizing: Ref<boolean>;
    /** `@pointerdown` */
    readonly start: (event: PointerEvent) => void;
    /** `@pointermove` */
    readonly move: (event: PointerEvent) => void;
    /** `@pointerup` and `@pointercancel` */
    readonly end: (event: PointerEvent) => void;
}

/**
 * Wire a resize handle for pointerdown/pointermove/pointerup/pointercancel.
 *
 * @param onMove Called with the pointer event on each move during a drag.
 * @param onStart Called once at gesture start; read state that must be captured before the drag begins (a start edge,
 * the initial pointer position).
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
