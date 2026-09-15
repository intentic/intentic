import { onBeforeUnmount, onMounted, readonly, ref } from "vue";

// Whether the reader asked for less motion, for the glyphs that move: they slow down rather than stop, since a still
// mark beside a live turn reads as a hung one. Per-component and not a module singleton on purpose — the listener has
// to go when its component does, and `window.matchMedia` is swapped between mounts under test.
export function useReducedMotion() {
    const reduced = ref(false);
    let query: MediaQueryList | undefined;
    const read = (): void => {
        reduced.value = query?.matches === true;
    };
    onMounted(() => {
        if (typeof window.matchMedia !== `function`) {
            return;
        }
        query = window.matchMedia(`(prefers-reduced-motion: reduce)`);
        read();
        query.addEventListener(`change`, read);
    });
    onBeforeUnmount(() => query?.removeEventListener(`change`, read));
    return readonly(reduced);
}
