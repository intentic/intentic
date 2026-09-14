import { computed, readonly, ref, type ComputedRef, type Ref } from "vue";

export type Device = "mobile" | "tablet" | "desktop";

/* Module-level singleton (same pattern as useOsPreference): every consumer shares one set of media-query listeners. */

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

/* Pixels of layout occluded by the on-screen keyboard (0 when closed). */
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
