import { onScopeDispose, ref, watch, type Ref } from "vue";

/* When a wait is allowed to be SEEN.
 *
 * A round-trip that answers in 120ms and a placeholder that shows for 120ms are not the same event. The first
 * is instant; the second is a flash of grey the eye reads as a fault, and it costs the reader the frame after
 * it re-finding where the content went. A placeholder that flashes is worse than none at all, which is why
 * every loading state worth having is gated by two thresholds, and one without the other doesn't work:
 *
 *   reveal delay   nothing is drawn for the first beat, so a warm answer paints no placeholder at all.
 *   minimum hold   once drawn it stays for a floor, so an answer landing a moment past the delay can't
 *                  strobe it back off.
 *
 * `subject` is what is being waited ON, a conversation id, a file path. A wait on a different subject is a
 * different wait, not a continuation of the one before it, so switching subjects drops the hold immediately:
 * the floor exists to stop one wait flickering, never to hold a stale outline over something else.
 */

// Under this, the answer reads as immediate and nothing should be drawn. Roughly the interval below which a
// response feels like a direct consequence of the click (Nielsen's 0.1–1s band, at the fast end because the
// tab and its title are already on screen by then, the click is acknowledged with or without this).
const REVEAL_DELAY_MS = 200;
// Long enough that a revealed outline registers as a state the view was in, rather than as a blink.
const MINIMUM_HOLD_MS = 400;

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
                // Already visible, this wait joins the one on screen instead of re-arming its delay.
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
