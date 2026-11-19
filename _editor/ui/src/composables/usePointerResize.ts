import { getCurrentScope, onScopeDispose, ref, type Ref } from "vue";
import { beginResizeGesture, noteResizeMove } from "./resizeGesture.js";

// Shared resize-handle gesture used by every drag handle in the app. Pointer capture keeps a fast drag tracked even
// when the pointer leaves the handle. releasePointerCapture is guarded because pointercancel already releases
// capture before dispatching, and the `resizing` latch makes a repeated end a no-op. Each drag is one resize gesture
// (resizeGesture.ts): work that follows a pane's size waits for it, and preference writes are held until it ends.

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
    let endGesture: (() => void) | undefined;
    const finish = (): void => {
        resizing.value = false;
        endGesture?.();
        endGesture = undefined;
    };
    // A handle unmounted mid-drag (its pane closed under the pointer) never sees its pointerup: the gesture ends with it,
    // or the work it held back and the preferences it held would wait for a release that is not coming.
    if (getCurrentScope() !== undefined) {
        onScopeDispose(() => {
            if (resizing.value) {
                finish();
            }
        });
    }

    return {
        resizing,
        start: (event) => {
            // Or the browser starts a text selection / native drag under the handle instead of a resize.
            event.preventDefault();
            onStart?.(event);
            resizing.value = true;
            endGesture ??= beginResizeGesture();
            (event.target as HTMLElement).setPointerCapture(event.pointerId);
        },
        move: (event) => {
            if (!resizing.value) {
                return;
            }
            noteResizeMove();
            onMove(event);
        },
        end: (event) => {
            if (!resizing.value) {
                return;
            }
            const target = event.target as HTMLElement;
            if (target.hasPointerCapture(event.pointerId)) {
                target.releasePointerCapture(event.pointerId);
            }
            finish();
        },
    };
}
