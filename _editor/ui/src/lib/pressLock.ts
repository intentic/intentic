import { MINIMUM_HOLD_MS, REVEAL_DELAY_MS } from "../composables/loadingReveal.js";
import { onScopeDispose, ref, type Ref } from "vue";

/* WHAT A PRESS DOES BETWEEN THE CLICK AND THE ANSWER.
 *
 * A control that starts a round trip and then sits there looking untouched is telling the user the click
 * missed. So they click again, and the second press is a second request: the chat card's Approve sent its
 * reply twice, the daemon un-parked the turn on the first and answered the second with a 404, and the card
 * put "the turn may have ended" on screen for a decision that had in fact landed perfectly.
 *
 * Two things have to be true at once, and one without the other is not worth having:
 *
 *   LOCKED, in the same tick as the click. Not after a round trip, not after a watcher, not on the next
 *   frame: the press that follows 90ms behind the first has to find a control that is already spoken for.
 *   Every guard that reads state the RESPONSE writes is blind for exactly the window it exists to cover.
 *
 *   WORKING, only once the wait is worth drawing. A spinner shown for 40ms is a flinch, not information,
 *   and it costs the reader the frame after it re-finding what moved. The thresholds are the ones the app
 *   already settled on for loading panes (useLoadingReveal), imported rather than re-picked.
 *
 * `locked` stays true while `working` is, including through the minimum hold after the work is done. A
 * control that is visibly spinning must not be clickable: the alternative is a button that says "working"
 * and answers a press anyway, which is the stale state this whole file exists to remove.
 *
 * NOTHING HERE KNOWS ABOUT A BUTTON. The component (components/Button.vue) and the directive
 * (lib/pressAction.ts) are two renderings of this one state machine, and they share it so the app cannot
 * grow two answers to how a press feels. */

export interface PressState {
    /** Spoken for. Set synchronously on the click; nothing may fire again until it clears. */
    readonly locked: boolean;
    /** The wait has outlived the reveal delay and should now be shown. */
    readonly working: boolean;
}

// A promise by shape rather than by constructor: a handler may hand back a thenable from any library, and
// `instanceof Promise` refuses those for no reason a user would recognise.
export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    (typeof value === `object` || typeof value === `function`) &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === `function`;

/* Runs a click's own handlers and reports back the work they started, if any.
 *
 * Vue hands a listener over as ONE function, or as an array of them when a template stacks several on the
 * same element. Both spellings are ordinary here. A handler that returns nothing (the common case: a toggle,
 * a navigation) leaves the control untouched, which is the point: only actual waiting is drawn as waiting. */
export const firePress = (listener: unknown, event: Event): PromiseLike<unknown> | undefined => {
    const handlers = (Array.isArray(listener) ? listener : [listener]).filter(
        (entry): entry is (event: Event) => unknown => typeof entry === `function`,
    );
    // A rejection is the CALLER's to report: it has the words for what failed, and this only owns how long
    // the control stays held. Swallowed here so the hold can't itself become an unhandled rejection.
    const started = handlers.map((handler) => handler(event)).filter(isThenable);
    return started.length === 0
        ? undefined
        : Promise.all(started.map((work) => Promise.resolve(work).catch(() => undefined)));
};

export interface PressLock {
    /** Hold the control until `work` settles. Only call it when not already locked. */
    readonly hold: (work: PromiseLike<unknown>) => void;
    readonly dispose: () => void;
}

export const createPressLock = (notify: (state: PressState) => void): PressLock => {
    let running = 0;
    let working = false;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let shownAt = 0;
    let disposed = false;

    const emit = (): void => notify({ locked: running > 0 || working, working });

    // The work is done. Drop the spinner, unless it has been on screen for less than its floor, in which case
    // let it finish being seen: an outline that blinks off a frame after appearing reads as a fault.
    const settle = (): void => {
        if (disposed || running > 0) {
            return;
        }
        clearTimeout(revealTimer);
        revealTimer = undefined;
        const remaining = MINIMUM_HOLD_MS - (Date.now() - shownAt);
        if (!working || remaining <= 0) {
            working = false;
            emit();
            return;
        }
        holdTimer = setTimeout(() => {
            holdTimer = undefined;
            working = false;
            emit();
        }, remaining);
    };

    return {
        hold: (work) => {
            running += 1;
            if (revealTimer === undefined && !working) {
                revealTimer = setTimeout(() => {
                    revealTimer = undefined;
                    working = true;
                    shownAt = Date.now();
                    emit();
                }, REVEAL_DELAY_MS);
            }
            // Before the await, so the lock is on the control in the same tick the click arrived in.
            emit();
            void Promise.resolve(work)
                .catch(() => undefined)
                .then(() => {
                    running -= 1;
                    settle();
                });
        },
        dispose: () => {
            disposed = true;
            clearTimeout(revealTimer);
            clearTimeout(holdTimer);
        },
    };
};

export interface Press {
    readonly locked: Ref<boolean>;
    readonly working: Ref<boolean>;
    /** Wire this to the element's click: it fires `listener` and holds the control if that started work. */
    readonly press: (listener: unknown, event: Event) => void;
}

export const usePress = (): Press => {
    const locked = ref(false);
    const working = ref(false);
    const lock = createPressLock((state) => {
        locked.value = state.locked;
        working.value = state.working;
    });
    onScopeDispose(lock.dispose);
    return {
        locked,
        working,
        press: (listener, event) => {
            // Belt to the `disabled` attribute's braces. A disabled <button> swallows clicks on its own, but
            // the same lock guards links and role="button" rows, where nothing does.
            if (locked.value) {
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            const work = firePress(listener, event);
            if (work !== undefined) {
                lock.hold(work);
            }
        },
    };
};
