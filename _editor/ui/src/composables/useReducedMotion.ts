import { onBeforeUnmount, readonly, ref, watch, type Ref } from "vue";

// Whether the reader asked for less motion, for the glyphs that move: they slow down rather than stop, since a still
// mark beside a live turn reads as a hung one. Per-component and not a module singleton on purpose — the listener has
// to go when its component does, and `window.matchMedia` is swapped between mounts under test.
//
// `active` narrows WHEN the question is asked at all: an Icon is mounted a thousand times and spins in a handful of
// places, so the query and its listener exist only while the caller actually moves (a spinner on a desktop pointer,
// see useTouchMotion below). Absent, it is asked for the component's whole life.
export function useReducedMotion(active: () => boolean = () => true): Readonly<Ref<boolean>> {
    const reduced = ref(false);
    let query: MediaQueryList | undefined;
    const read = (): void => {
        reduced.value = query?.matches === true;
    };
    const release = (): void => {
        query?.removeEventListener(`change`, read);
        query = undefined;
    };
    watch(
        active,
        (moving) => {
            if (!moving) {
                release();
                return;
            }
            if (query !== undefined || !(`matchMedia` in globalThis)) {
                return;
            }
            query = globalThis.matchMedia(`(prefers-reduced-motion: reduce)`);
            read();
            query.addEventListener(`change`, read);
        },
        { immediate: true },
    );
    onBeforeUnmount(release);
    return readonly(reduced);
}

// WHERE A LOOPING GLYPH MAY RUN, as a question about the screen: true on a touch-first one (a phone, a tablet), where
// the glyph turns as a CSS animation on its own compositor layer, and false under a desktop pointer, where it stays SMIL.
// SMIL is the desktop's answer because Chrome DevTools rebuilds an open Styles editor whenever a CSS animation starts or
// stops (reducedMotion.test.ts), and a spinner starts on every request. It is the wrong answer on a phone: SMIL runs on
// the main thread and re-styles, re-lays-out and re-paints the page every frame it is on screen — measured on the /agents
// board at 4× CPU throttle, nine spinners held the main thread 56% busy with nothing happening, and 3% once they turned
// as CSS transforms. Nobody edits styles in DevTools on the phone itself; device emulation matches too, which is the one
// place the two answers meet.
//
// One shared query, bound on first use rather than at import: a test that stubs `window.matchMedia` gets a fresh binding
// on its next mount, and the previous one lets go of its listener.
const TOUCH_QUERY = `(hover: none) and (pointer: coarse)`;
// allow(module-state): one answer about the screen for every glyph in the window, not about a sandbox.
const touchState = ref(false);
let touchSource: typeof globalThis.matchMedia | undefined;
let touchList: MediaQueryList | undefined;
const onTouchChange = (event: MediaQueryListEvent): void => {
    touchState.value = event.matches;
};

export function useTouchMotion(): Readonly<Ref<boolean>> {
    const matchMedia = `matchMedia` in globalThis ? globalThis.matchMedia : undefined;
    if (matchMedia !== undefined && matchMedia !== touchSource) {
        touchList?.removeEventListener(`change`, onTouchChange);
        touchSource = matchMedia;
        touchList = globalThis.matchMedia(TOUCH_QUERY);
        touchState.value = touchList.matches;
        touchList.addEventListener(`change`, onTouchChange);
    }
    return readonly(touchState);
}
