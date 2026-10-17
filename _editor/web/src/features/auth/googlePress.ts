import { onScopeDispose, ref, type Ref } from "vue";
import { track } from "../../app/analytics";

// What became of a press on Google's own button, which this page cannot hear: the button is Google's markup (often
// Google's frame), and the window it opens answers only on success. Where the browser has no FedCM that window is a
// pop-up, and a blocker, tracking protection or a closed window ends it without a word, so the button looked dead:
// one reader pressed it for thirteen minutes across four tabs. What the page can see is its own focus leaving for
// Google's window and coming back; a press that comes back with no answer is a sign-in that will not finish there.

// Whether this browser has FedCM. Without it Google's button opens a pop-up, which can fail silently.
export const hasFedCm = (): boolean => `IdentityCredential` in window;

// How often a press still waiting on Google is looked at.
const TICK_MS = 500;
// Back on this page with no answer. Focus coming back is no sign Google's window is done: a click on this page, a
// Windows or passkey prompt, or a phone-approval wait all hand it back while the sign-in is still going, and one
// completed 48 s after the page had already declared it dead. So this is long enough for a second factor, and what it
// raises is an offer (the note says "still waiting?"), not a verdict.
const BACK_GRACE_MS = 25_000;
// The press opened nothing this page saw come up (a blocked pop-up, a window that never drew); longer, since a FedCM
// dialog may sit inside this window without taking its focus while the reader picks an account.
const UNSEEN_MS = 8_000;

export interface GooglePress {
    // True once a press came back without an answer; stays up, since the road around the button is what helps now.
    readonly stalled: Readonly<Ref<boolean>>;
    // The press in flight was answered (a refusal the page says itself, or a dismissal): stop timing it.
    readonly answered: () => void;
    // The credential arrived: stop timing, take down a note already shown (the sign-in did finish after all), and count
    // the sign-in with whether the reader had been told it stalled, which is how the note's grace is tuned.
    readonly completed: () => void;
}

// Watches presses on Google's button inside `slot`. `surface` names the page in the stall's analytics event.
export const useGooglePress = (slot: Readonly<Ref<HTMLElement | undefined>>, surface: `login` | `desktop-auth`): GooglePress => {
    const stalled = ref(false);
    let timer: ReturnType<typeof setInterval> | undefined;
    // Time counted toward the limit in force: since the press, then afresh since the reader came back.
    let waited = 0;
    // This page lost the focus after the press: Google's window came up in front of it.
    let left = false;
    // The last key was Tab, so focus entering Google's frame is the keyboard passing through, not a press.
    let tabbing = false;

    const inside = (node: EventTarget | null): boolean => node instanceof Node && slot.value?.contains(node) === true;

    const stop = (): void => {
        clearInterval(timer);
        timer = undefined;
    };

    const stall = (): void => {
        stop();
        stalled.value = true;
        // The gate's own funnel event, so a sign-in that stalls on the button counts beside one that never got that far.
        track(`sandbox_signin_gate`, { reason: `button-stalled`, mode: `button`, surface, fedcm: hasFedCm(), left });
    };

    const completed = (): void => {
        stop();
        track(`signin_completed`, { method: `google`, stall_shown: stalled.value });
        stalled.value = false;
    };

    const tick = (): void => {
        // The button has gone (the page moved on): nothing is left to wait for.
        if (slot.value?.isConnected !== true) {
            stop();
            return;
        }
        if (!document.hasFocus()) {
            left = true;
            waited = 0;
            return;
        }
        waited += TICK_MS;
        if (waited >= (left ? BACK_GRACE_MS : UNSEEN_MS)) {
            stall();
        }
    };

    const pressed = (): void => {
        if (stalled.value) {
            return;
        }
        waited = 0;
        left = false;
        timer ??= setInterval(tick, TICK_MS);
    };

    // A press on a button Google drew into this document itself, as it does where it opens a pop-up.
    const onPointerDown = (event: PointerEvent): void => {
        tabbing = false;
        if (inside(event.target)) {
            pressed();
        }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
        tabbing = event.key === `Tab`;
        if ((event.key === `Enter` || event.key === ` `) && inside(event.target)) {
            pressed();
        }
    };
    // A press inside Google's frame, which shows here only as this window's focus moving into it. Read a turn later,
    // since the newly focused frame is not yet the active element while its blur is dispatched.
    const onBlur = (): void => {
        if (tabbing) {
            return;
        }
        setTimeout(() => {
            if (inside(document.activeElement)) {
                pressed();
            }
        });
    };

    document.addEventListener(`pointerdown`, onPointerDown, true);
    document.addEventListener(`keydown`, onKeyDown, true);
    window.addEventListener(`blur`, onBlur);
    onScopeDispose(() => {
        stop();
        document.removeEventListener(`pointerdown`, onPointerDown, true);
        document.removeEventListener(`keydown`, onKeyDown, true);
        window.removeEventListener(`blur`, onBlur);
    });

    return { stalled, answered: stop, completed };
};
