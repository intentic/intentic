import { computed, type ComputedRef, ref, watch } from "vue";

// WHETHER THE INTERFACE MOVES, as one answer for the whole window: the OS's reduce-motion switch, and nothing else (the
// app keeps no setting of its own over it). The answer is written to <html> as `data-motion="reduced"` (absent means
// full motion), and that attribute is what every stylesheet reads: motion.css zeroes the duration tokens and stills
// every transition under it, so a component never asks for itself. The few moves played from script (the board's folds
// and flights) ask `lessMotion()` below before they start.

const ATTRIBUTE = `data-motion`;
export const REDUCE_MOTION_QUERY = `(prefers-reduced-motion: reduce)`;

// The OS's answer, live, bound once for the window like useTheme's scheme query.
const reduceQuery = `matchMedia` in globalThis ? globalThis.matchMedia(REDUCE_MOTION_QUERY) : undefined;
// allow(module-state): the OS's one reduce-motion answer for the window, not about a sandbox.
const osReduces = ref(reduceQuery?.matches === true);
reduceQuery?.addEventListener(`change`, (event) => {
    osReduces.value = event.matches;
});

const reduced: ComputedRef<boolean> = computed(() => osReduces.value);

const apply = (less: boolean): void => {
    if (!(`document` in globalThis)) {
        return;
    }
    if (less) {
        document.documentElement.setAttribute(ATTRIBUTE, `reduced`);
    } else {
        document.documentElement.removeAttribute(ATTRIBUTE);
    }
};

// `sync`, so no frame moves after the OS said stop.
watch(reduced, apply, { immediate: true, flush: `sync` });

/**
 * Whether a move about to be played from script should be skipped, asked at the moment it starts. Reads the OS afresh
 * rather than through the bound query, so a page whose `matchMedia` was swapped (a test DOM) is answered by the new one.
 */
export const lessMotion = (): boolean => {
    const asked = `matchMedia` in globalThis ? globalThis.matchMedia(REDUCE_MOTION_QUERY) : undefined;
    return asked?.matches === true;
};

export function useMotion() {
    return { reduced };
}
