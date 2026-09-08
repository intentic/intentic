import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from "vue";

// Measures pinned chrome height and publishes it as `--pinned-top`, so stacked sticky elements below it can offset
// via CSS instead of a prop. Uses ResizeObserver rather than a container query: `container-type` would make
// anchored overlays inside the bar (a Picker menu, an InfoHint popover) position against it.

export interface StickyTop {
    /** Bind on the surface that owns the pinned stack: `:style="pinned.style"`. */
    readonly style: ComputedRef<Record<string, string>>;
    /** The measured height in px, for a caller that needs the number rather than the property. */
    readonly height: ComputedRef<number>;
}

/**
 * Measure `element` and publish its height as `--pinned-top`.
 *
 * @param element The chrome that pins above everything else on this surface (a filter bar, a toolbar).
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
            // No element, or no ResizeObserver (component tests): zero matches a surface with no pinned chrome.
            if (el === undefined || typeof ResizeObserver === `undefined`) {
                height.value = 0;
                return;
            }
            observer = new ResizeObserver(([entry]) => {
                // Border box: what the next pinned element must clear, padding included.
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
