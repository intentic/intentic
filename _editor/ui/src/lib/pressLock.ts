import { MINIMUM_HOLD_MS, REVEAL_DELAY_MS } from "../composables/loadingReveal.js";
import { onScopeDispose, ref, type Ref } from "vue";

// State machine for a press between click and answer. `locked` is set synchronously on click, so a second click
// before the response can't double-submit. `working` only shows after the reveal delay, and holds through the
// minimum hold once shown. Shared by Button.vue and pressAction.ts.

export interface PressState {
    /** Spoken for. Set synchronously on the click; nothing may fire again until it clears. */
    readonly locked: boolean;
    /** The wait has outlived the reveal delay and should now be shown. */
    readonly working: boolean;
}

// Duck-typed rather than `instanceof Promise`, since a thenable may come from another library.
export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    (typeof value === `object` || typeof value === `function`) &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === `function`;

// Runs a click's handler(s) (Vue may hand one function or an array) and reports back any work they started. A
// handler returning nothing leaves the control untouched.
export const firePress = (listener: unknown, event: Event): PromiseLike<unknown> | undefined => {
    const handlers = (Array.isArray(listener) ? listener : [listener]).filter(
        (entry): entry is (event: Event) => unknown => typeof entry === `function`,
    );
    // Rejections are the caller's to report; swallowed here so the hold can't itself reject.
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

    // Work is done: drop the spinner, unless it's been on screen less than its minimum hold, in which case let it
    // finish being seen (blinking off immediately reads as a fault).
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
            // Backs up `disabled`, which a link or role="button" row has no equivalent of.
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
