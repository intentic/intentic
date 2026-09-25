import { getCurrentScope, onScopeDispose, type Ref, readonly, ref } from "vue";

// The clock between a pointer and a surface it can raise: a card, a quick look, a box that grows. A pointer crossing on
// its way somewhere else must raise nothing (`open`), one overshooting an edge must be able to come back (`close`), and
// once one card is up the next one along shows at once, a readiness that outlives a close by `warm`, as tooltips do.
// Every hover-raised surface uses this rather than its own timers, so they all feel the same under the hand.

export interface HoverIntentOptions {
    /** How long a pointer has to stay before `enter` opens, in ms. */
    readonly open?: number;
    /** How long after `leave` the surface stays, in ms, so an overshoot can come back to it. */
    readonly close?: number;
    /** How long after closing a later `enter` still opens at once, in ms. */
    readonly warm?: number;
}

export interface HoverIntent {
    /** Whether the surface is up, as this clock last opened or closed it. */
    readonly shown: Readonly<Ref<boolean>>;
    /** The pointer arrived: opens after the dwell (at once while shown or warm), running `then` as it does. */
    enter(then?: () => void): void;
    /** The pointer left: closes after the grace, running `then` as it does, unless it arrives again first. */
    leave(then?: () => void): void;
    /** Opens now, whatever is pending: a focus, a press. */
    show(then?: () => void): void;
    /** Closes now, whatever is pending: a blur, a press, Escape, the surface closed by some other route. */
    hide(then?: () => void): void;
    /** Drops whatever is pending and leaves the surface as it is: the pointer reached the card itself. */
    cancel(): void;
}

export const useHoverIntent = ({ open = 0, close = 0, warm = 0 }: HoverIntentOptions = {}): HoverIntent => {
    const shown = ref(false);
    let pending: ReturnType<typeof setTimeout> | undefined;
    // Set while a close is recent enough that the next `enter` should not wait.
    let warmth: ReturnType<typeof setTimeout> | undefined;

    const cancel = (): void => {
        clearTimeout(pending);
        pending = undefined;
    };
    const after = (delay: number, run: () => void): void => {
        cancel();
        if (delay <= 0) {
            run();
            return;
        }
        pending = setTimeout(() => {
            pending = undefined;
            run();
        }, delay);
    };
    const opened = (then?: () => void): void => {
        clearTimeout(warmth);
        warmth = undefined;
        shown.value = true;
        then?.();
    };
    const closed = (then?: () => void): void => {
        if (shown.value && warm > 0) {
            clearTimeout(warmth);
            warmth = setTimeout(() => {
                warmth = undefined;
            }, warm);
        }
        shown.value = false;
        then?.();
    };

    if (getCurrentScope() !== undefined) {
        onScopeDispose(() => {
            cancel();
            clearTimeout(warmth);
        });
    }

    return {
        shown: readonly(shown),
        enter: (then) => after(shown.value || warmth !== undefined ? 0 : open, () => opened(then)),
        leave: (then) => after(close, () => closed(then)),
        show: (then) => after(0, () => opened(then)),
        hide: (then) => after(0, () => closed(then)),
        cancel,
    };
};
