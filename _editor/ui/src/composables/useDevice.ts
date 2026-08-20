import { computed, readonly, ref, type ComputedRef, type Ref } from "vue";

export type Device = "mobile" | "tablet" | "desktop";

/* Module-level singleton (same pattern as useOsPreference): every consumer shares one set of media-query
 * listeners. Breakpoints mirror Tailwind's `md` (768) and `lg` (1024) so template classes and JS agree.
 * `mobile` is the only flag that swaps component trees, tablet keeps the desktop shell and only picks up
 * the coarse-pointer affordances (long-press menus, 44px targets). */

const track = (query: string): Ref<boolean> => {
    const mq = window.matchMedia(query);
    const state = ref(mq.matches);
    mq.addEventListener(`change`, (event) => {
        state.value = event.matches;
    });
    return state;
};

const belowMd = track(`(max-width: 767.98px)`);
const belowLg = track(`(max-width: 1023.98px)`);
const coarseState = track(`(pointer: coarse)`);

const mobile = computed(() => belowMd.value);
const device: ComputedRef<Device> = computed(() => {
    if (belowMd.value) {
        return `mobile`;
    }
    return belowLg.value ? `tablet` : `desktop`;
});

/* Pixels of layout occluded by the on-screen keyboard (0 when closed). iOS Safari does not resize the
 * layout viewport for the keyboard, only the visual viewport, this ref bridges the gap so composers can
 * pad themselves above it. On browsers that do resize the layout (interactive-widget=resizes-content),
 * the delta stays 0 and the padding is a no-op. */
const keyboardInsetState = ref(0);
const vv = window.visualViewport;
if (vv) {
    const update = (): void => {
        keyboardInsetState.value = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    };
    vv.addEventListener(`resize`, update);
    vv.addEventListener(`scroll`, update);
}

const coarse = readonly(coarseState);
const keyboardInset = readonly(keyboardInsetState);

export function useDevice() {
    return { device, mobile, coarse, keyboardInset };
}
