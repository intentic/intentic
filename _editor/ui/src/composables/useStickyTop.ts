import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from "vue";

/* HOW MUCH CHROME IS ALREADY PINNED ABOVE ME, measured, and published as `--pinned-top`.
 *
 * A page-scrolling surface usually pins more than one thing, and everything below the first has to know where
 * the first one ENDS. The knowledge section pins a search bar, then a note's identity bar and an index column
 * under it; a hub pins its section rail. Written as a `top-11` on each of the lower ones, that offset is a
 * number somebody read off a screenshot, and it is wrong at every width where the bar above wraps — which for
 * a filter bar carrying a field, two pickers and a count is most of them. Wrong here means the top row of the
 * index sitting behind the search field, permanently, with nothing on screen to say so.
 *
 * SO IT IS MEASURED AND SHARED, not passed. Three consumers want the same number on the knowledge section (the
 * note frame's pinned header, the sticky index column's `top` and `max-height`, and the `scroll-margin-top` that
 * keeps a keyboard-revealed row clear of both), and a custom property reaches all three through the cascade
 * without any of them taking a prop about a bar they do not draw. `tokens.css` gives it a `0px` default, so a
 * surface that pins nothing needs no measuring and every consumer still resolves.
 *
 * A ResizeObserver rather than a container query, for the reason useNarrow gives: `container-type` makes an
 * element a containing block for its fixed descendants, and the bars this measures are full of anchored
 * overlays (a Picker's menu, an InfoHint's popover). */

export interface StickyTop {
    /** Bind on the surface that owns the pinned stack: `:style="pinned.style"`. */
    readonly style: ComputedRef<Record<string, string>>;
    /** The measured height in px, for a caller that needs the number rather than the property. */
    readonly height: ComputedRef<number>;
}

/**
 * Measure `element` and publish its height as `--pinned-top`.
 *
 * @param element The chrome that pins ABOVE everything else on this surface (a filter bar, a toolbar).
 */
export function useStickyTop(element: Readonly<Ref<HTMLElement | undefined>>): StickyTop {
    const height = ref(0);

    let observer: ResizeObserver | undefined;
    const unobserve = (): void => {
        observer?.disconnect();
        observer = undefined;
    };

    watch(
        element,
        (el) => {
            unobserve();
            /* Nothing to measure, or nothing to measure WITH: a component-test DOM has no ResizeObserver, and
             * zero is the honest answer there, the same layout a surface with no pinned chrome gets. */
            if (el === undefined || typeof ResizeObserver === `undefined`) {
                height.value = 0;
                return;
            }
            observer = new ResizeObserver(([entry]) => {
                // The BORDER box: what the next pinned thing has to clear is the space this one occupies on
                // screen, which includes whatever padding it paints the gap below itself with.
                height.value = entry?.borderBoxSize?.[0]?.blockSize ?? entry?.target.getBoundingClientRect().height ?? 0;
            });
            observer.observe(el);
        },
        { immediate: true },
    );
    onUnmounted(unobserve);

    return {
        style: computed(() => ({ [`--pinned-top`]: `${Math.round(height.value)}px` })),
        height: computed(() => height.value),
    };
}
