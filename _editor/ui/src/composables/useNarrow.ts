import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from "vue";
import { useTextSize } from "./useTextSize.js";

// Is this element narrower than the layout it wants, measured off the element, never the window: a view
// renders into a pane (beside a rail, a draggable chat panel), so a viewport media query answers a
// question nobody asked. A ResizeObserver, not a container query, since `container-type` would break
// any fixed-position descendant (a drag ghost, an anchored overlay) inside it.

// Hysteresis: the answer can move what it measures (folding a layout can summon a scrollbar, changing
// the width that produced the fold), so switching back requires clearing the threshold by a margin.
const HYSTERESIS_REM = 1.5;

const rootFontSize = (): number => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

export function useNarrow(element: Readonly<Ref<HTMLElement | undefined>>, at: number): ComputedRef<boolean> {
    // Unmeasured reads as wide, and the element is measured the moment it arrives rather than on the observer's
    // first callback: that callback can land a frame after the first paint, and on a phone that frame drew the /agents
    // header in its wide layout and then folded it, shifting every card below it (0.41 of the page's measured CLS).
    const narrow = ref(false);
    let width = Number.POSITIVE_INFINITY;
    const judge = (): void => {
        narrow.value = width < (narrow.value ? at + HYSTERESIS_REM : at) * rootFontSize();
    };

    let observer: ResizeObserver | undefined;
    const unobserve = (): void => {
        observer?.disconnect();
        observer = undefined;
    };
    watch(
        element,
        (el) => {
            unobserve();
            // No element, or no ResizeObserver (a component-test DOM): nothing measures, so the unmeasured default
            // stands.
            if (el === undefined || typeof ResizeObserver === `undefined`) {
                return;
            }
            observer = new ResizeObserver(([entry]) => {
                width = entry?.contentRect.width ?? width;
                judge();
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
    watch(useTextSize().scale, judge);
    onUnmounted(unobserve);

    return computed(() => narrow.value);
}
