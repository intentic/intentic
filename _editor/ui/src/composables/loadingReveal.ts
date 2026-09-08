import { onScopeDispose, ref, watch, type Ref } from "vue";

// When a wait is allowed to be seen: gated by two thresholds, so a fast answer paints no placeholder
// and a slow one, once shown, holds long enough to register rather than flicker. `subject` is what's
// being waited on; switching it drops the hold immediately rather than holding a stale outline over
// something else.

// Under this, an answer reads as immediate; nothing should be drawn below it.
export const REVEAL_DELAY_MS = 200;
// Long enough that a revealed outline registers as a state, not a blink.
export const MINIMUM_HOLD_MS = 400;

export const useLoadingReveal = (loading: Ref<boolean>, subject: Ref<string>): Ref<boolean> => {
    const revealed = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revealedAt = 0;
    const cancel = (): void => {
        clearTimeout(timer);
        timer = undefined;
    };

    watch(
        [loading, subject],
        ([isLoading], previous) => {
            cancel();
            // A subject change resets rather than transitions: whatever was on screen belonged to the old one.
            if (previous !== undefined && previous[1] !== subject.value) {
                revealed.value = false;
            }
            if (isLoading) {
                // Already visible: this wait joins the one on screen instead of re-arming its delay.
                if (revealed.value) {
                    return;
                }
                timer = setTimeout(() => {
                    revealed.value = true;
                    revealedAt = Date.now();
                }, REVEAL_DELAY_MS);
                return;
            }
            if (!revealed.value) {
                return;
            }
            const remaining = MINIMUM_HOLD_MS - (Date.now() - revealedAt);
            if (remaining <= 0) {
                revealed.value = false;
                return;
            }
            timer = setTimeout(() => (revealed.value = false), remaining);
        },
        { immediate: true },
    );

    onScopeDispose(cancel);
    return revealed;
};
