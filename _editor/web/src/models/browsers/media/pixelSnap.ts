import { onScopeDispose, ref, type Ref, watch } from "vue";
import { type RatioWindow, watchPixelRatio, windowOf } from "./pixelRatio";

// THE PICTURE ON WHOLE DEVICE PIXELS. castd's picture is the stage's box × devicePixelRatio, drawn 1:1, and text is only
// pixel-exact if the canvas also starts on a device pixel: at DPR 1.5 a stage 100.33 CSS px from the window's left
// puts every picture pixel across two screen pixels, which is a blur. The canvas is nudged by the fraction of a device
// pixel it sits off the grid, measured each time it could have moved: its own size, its window's size and ratio, and each
// new picture. The window is the element's own, so a pane popped out onto another screen snaps to that screen's pixels.

/** The fraction of a device pixel `at` (CSS px) sits past the nearest device pixel, in CSS px, to take back off. */
const snapOffset = (at: number, ratio: number): number =>
    ratio > 0 && Number.isFinite(at) ? (Math.round(at * ratio) - at * ratio) / ratio : 0;

// The window an element is in, as far as snapping reads it: its ratio, and its resizes.
type SnapWindow = RatioWindow & Pick<Window, `addEventListener` | `removeEventListener`>;

/** A transform for `element` that puts its top-left corner on a device pixel; undefined when it is there already. */
export const usePixelSnap = (element: Ref<HTMLElement | null>, moved: Ref<object | undefined>): Ref<{ transform: string } | undefined> => {
    const style = ref<{ transform: string } | undefined>();
    let applied = { x: 0, y: 0 };
    const measure = (): void => {
        const box = element.value?.getBoundingClientRect();
        if (box === undefined) {
            return;
        }
        // The box as laid out, without the nudge already applied.
        const left = box.left - applied.x;
        const top = box.top - applied.y;
        const ratio = windowOf(element.value).devicePixelRatio;
        applied = { x: snapOffset(left, ratio), y: snapOffset(top, ratio) };
        style.value =
            Math.abs(applied.x) < 0.001 && Math.abs(applied.y) < 0.001 ? undefined : { transform: `translate(${applied.x}px, ${applied.y}px)` };
    };
    const observer = `ResizeObserver` in window ? new ResizeObserver(measure) : undefined;
    // The resizes and ratio changes of the window the element is in now.
    let unbind: (() => void) | undefined;
    const bind = (view: SnapWindow): void => {
        unbind?.();
        view.addEventListener(`resize`, measure);
        const stopRatio = watchPixelRatio(measure, view);
        unbind = () => {
            view.removeEventListener(`resize`, measure);
            stopRatio();
        };
    };
    watch(element, (now, before) => {
        if (before !== null && before !== undefined) {
            observer?.unobserve(before);
        }
        applied = { x: 0, y: 0 };
        style.value = undefined;
        if (now !== null) {
            observer?.observe(now);
            bind(windowOf(now));
        }
    });
    watch(moved, () => requestAnimationFrame(measure));
    bind(window);
    onScopeDispose(() => {
        observer?.disconnect();
        unbind?.();
    });
    return style;
};
