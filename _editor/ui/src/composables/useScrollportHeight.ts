import { onUnmounted, ref, watch, type Ref } from "vue";

// How tall the box is that `element` scrolls in, so a column pinned to its top (`sticky top-0`) can be exactly as tall
// as what shows of it. `max-h-dvh` overshoots by whatever chrome stands above and below the pane (a status bar, a
// window band), and the overshoot is the bottom of the column: rows nobody can scroll to.

const scrollerOf = (start: HTMLElement): HTMLElement | undefined => {
    let el: HTMLElement | null = start.parentElement;
    while (el !== null) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === `auto` || overflowY === `scroll`) {
            return el;
        }
        el = el.parentElement;
    }
    return undefined;
};

/**
 * The client height of the nearest scrolling ancestor of `element`, in pixels, kept current as it resizes.
 *
 * @param element The element whose scrollport is measured; nothing (unmounted, or no scrolling ancestor) reads as undefined.
 */
export function useScrollportHeight(element: Readonly<Ref<HTMLElement | undefined>>): Readonly<Ref<number | undefined>> {
    const height = ref<number | undefined>(undefined);
    let observer: ResizeObserver | undefined;
    const stop = (): void => {
        observer?.disconnect();
        observer = undefined;
    };
    watch(
        element,
        (el) => {
            stop();
            const scroller = el instanceof HTMLElement ? scrollerOf(el) : undefined;
            // A component-test DOM has no ResizeObserver: nothing measures, and the column keeps its fallback cap.
            if (scroller === undefined || !(`ResizeObserver` in globalThis)) {
                height.value = undefined;
                return;
            }
            height.value = scroller.clientHeight;
            observer = new ResizeObserver(() => {
                height.value = scroller.clientHeight;
            });
            observer.observe(scroller);
        },
        { immediate: true },
    );
    onUnmounted(stop);
    return height;
}
