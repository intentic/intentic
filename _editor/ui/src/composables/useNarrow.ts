import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from "vue";
import { useTextSize } from "./useTextSize.js";

// Is this element narrower than the layout it wants, measured off the element, never the window: a view
// renders into a pane (beside a rail, a draggable chat panel), so a viewport media query answers a
// question nobody asked. A ResizeObserver, not a container query, since `container-type` would break
// any fixed-position descendant (a drag ghost, an anchored overlay) inside it.

// Hysteresis: the answer can move what it measures (folding a layout can summon a scrollbar, changing
// the width that produced the fold), so switching back requires clearing the threshold by a margin.
export const NARROW_HYSTERESIS_REM = 1.5;

// The root's font size, read once per text-size rung (the one thing that moves it, with the browser's own base size)
// rather than on every resize: each read made the browser work out the page's style in the middle of the resize
// observers' turn, after an earlier observer's callback had changed it.
let rootFont: { readonly scale: number; readonly px: number } | undefined;
const rootFontSize = (scale: number): number => {
    if (rootFont?.scale !== scale) {
        rootFont = { scale, px: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16 };
    }
    return rootFont.px;
};

export function useNarrow(element: Readonly<Ref<HTMLElement | undefined>>, at: number): ComputedRef<boolean> {
    // Unmeasured reads as wide, and the element is measured the moment it arrives rather than on the observer's
    // first callback: that callback can land a frame after the first paint, and on a phone that frame drew the /agents
    // header in its wide layout and then folded it, shifting every card below it (0.41 of the page's measured CLS).
    const narrow = ref(false);
    let width = Number.POSITIVE_INFINITY;
    const { scale } = useTextSize();
    const verdict = (): boolean => width < (narrow.value ? at + NARROW_HYSTERESIS_REM : at) * rootFontSize(scale.value);
    const judge = (): void => {
        narrow.value = verdict();
    };

    let observer: ResizeObserver | undefined;
    // A fold the observer calls for is made on the next frame, not inside its callback: folding lays the pane out anew,
    // which can resize what is being observed, and a callback that does so makes the browser abandon the rest of the
    // frame's notifications ("ResizeObserver loop completed with undelivered notifications") and lay the page out again
    // under every observer after it.
    let fold = 0;
    const unobserve = (): void => {
        observer?.disconnect();
        observer = undefined;
        if (fold !== 0) {
            cancelAnimationFrame(fold);
            fold = 0;
        }
    };
    watch(
        element,
        (el) => {
            unobserve();
            // No element (Vue sets a template ref to null once its element unmounts), or no ResizeObserver (a
            // component-test DOM): nothing measures, so the unmeasured default stands.
            if (!(el instanceof Element) || typeof ResizeObserver === `undefined`) {
                return;
            }
            observer = new ResizeObserver(([entry]) => {
                width = entry?.contentRect.width ?? width;
                if (fold === 0 && verdict() !== narrow.value) {
                    fold = requestAnimationFrame(() => {
                        fold = 0;
                        judge();
                    });
                }
            });
            observer.observe(el);
            // The content box, as the observer reports it; an element not laid out yet (0 wide) waits for the observer.
            const style = getComputedStyle(el);
            const measured = el.getBoundingClientRect().width - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
            if (measured > 0) {
                width = measured;
                judge();
            }
        },
        { immediate: true },
    );
    // The one resize the observer can't see: the app's text-size setting rescales every rem while the pane
    // stays the same number of pixels wide.
    watch(scale, judge);
    onUnmounted(unobserve);

    return computed(() => narrow.value);
}
