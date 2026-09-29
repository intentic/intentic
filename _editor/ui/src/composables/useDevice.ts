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

// Whether the on-screen keyboard is up. The inset above cannot say: with `interactive-widget=resizes-content`
// (index.html) Chrome on Android shrinks the layout viewport with the visual one, so their difference stays 0 while
// the keyboard covers half the screen. So a focused editor with the viewport this much shorter than it last was with
// nothing focused (at the same width, so a rotation is not a keyboard) counts as the keyboard, either way it shows.
const KEYBOARD_MIN_PX = 100;
export const keyboardOcclusion = (layoutHeight: number, visualHeight: number, offsetTop: number, unfocusedHeight: number, editing: boolean): number =>
    editing ? Math.max(0, Math.round(layoutHeight - visualHeight - offsetTop), Math.round(unfocusedHeight - visualHeight)) : 0;
const keyboardOpenState = ref(false);

const vv = window.visualViewport;
if (vv) {
    let unfocusedHeight = vv.height;
    let unfocusedWidth = vv.width;
    const editing = (): boolean => {
        const active = document.activeElement;
        return active instanceof HTMLElement && (active.isContentEditable || active.matches(`input, textarea, select, [role="textbox"]`));
    };
    const update = (): void => {
        const typing = editing();
        if (!typing) {
            if (vv.width === unfocusedWidth) {
                unfocusedHeight = Math.max(unfocusedHeight, vv.height);
            } else {
                unfocusedWidth = vv.width;
                unfocusedHeight = vv.height;
            }
        }
        keyboardInsetState.value = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        keyboardOpenState.value = keyboardOcclusion(window.innerHeight, vv.height, vv.offsetTop, unfocusedHeight, typing) >= KEYBOARD_MIN_PX;
    };
    vv.addEventListener(`resize`, update);
    vv.addEventListener(`scroll`, update);
    // Focus moves before the keyboard does; the resize that follows is what opens or closes it here.
    window.addEventListener(`focusin`, update);
    window.addEventListener(`focusout`, () => setTimeout(update, 0));
}

const coarse = readonly(coarseState);
const keyboardInset = readonly(keyboardInsetState);
const keyboardOpen = readonly(keyboardOpenState);

export function useDevice() {
    return { device, mobile, coarse, keyboardInset, keyboardOpen };
}
