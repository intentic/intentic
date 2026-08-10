import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from "vue";
import { useTextSize } from "./useTextSize.js";

/* IS THIS ELEMENT NARROWER THAN THE LAYOUT IT WANTS TO DRAW — measured off the element, never off the window.
 *
 * EVERY LAYOUT DECISION IN THIS APP IS ABOUT A PANE, NOT A SCREEN. A view renders into the workspace column,
 * which sits between the icon rail and a chat panel the user can drag to half the window — so a 1920px monitor
 * routinely hands a view 500px, and a viewport media query (or `useDevice`) answers a question nobody asked. It
 * says "desktop", the view lays out an index beside a body, and the body ends up 150px wide with its rows
 * running off the side of the pane. That is the bug this exists to make unrepresentable.
 *
 * A ResizeObserver rather than a CSS container query, for the reason the agents board found first: `container-type`
 * makes an element a containing block for its fixed-position descendants, so a drag ghost or an anchored overlay
 * inside it starts resolving against the container instead of the viewport. Measuring costs one observer and
 * constrains nothing. (Container queries stay exactly where nothing inside them is fixed — the chat column, the
 * capability grid.)
 *
 * THE THRESHOLD IS IN REM, because everything it is compared against is: a 16rem index, a 1rem gutter, a body
 * wide enough for its rows. The app's text-size setting moves the root font size (100/110/120%), so a pixel
 * threshold would fold late for a reader on `large` — exactly the reader with the least room to spare.
 */

/* HYSTERESIS, because the answer can move what it measures: folding an index above a body makes the page taller,
 * which can summon the pane's scrollbar, which takes ~10px back off the width that produced the answer — an
 * infinite flip between two layouts. Switching at the threshold and back only a bit above it costs nothing at
 * any width a person actually sits at. */
const HYSTERESIS_REM = 1.5;

const rootFontSize = (): number => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

export function useNarrow(element: Readonly<Ref<HTMLElement | undefined>>, at: number): ComputedRef<boolean> {
    /* Unmeasured reads as wide: the observer's first callback lands before the first paint, so the fallback is
     * never seen, and defaulting the other way would flash a folded layout onto every desktop mount. */
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
            /* No element, or no observer to give it to — a component-test DOM has no ResizeObserver, and a view
             * rendered there is not being looked at. Nothing measures, so nothing moves: the unmeasured default
             * above stands, which is the layout every one of these screens is written for. */
            if (el === undefined || typeof ResizeObserver === `undefined`) {
                return;
            }
            observer = new ResizeObserver(([entry]) => {
                width = entry?.contentRect.width ?? width;
                judge();
            });
            observer.observe(el);
        },
        { immediate: true },
    );
    // The one resize the observer cannot see: changing the app's text size rescales every rem in the layout
    // while leaving the pane the same number of pixels wide.
    watch(useTextSize().scale, judge);
    onUnmounted(unobserve);

    return computed(() => narrow.value);
}
