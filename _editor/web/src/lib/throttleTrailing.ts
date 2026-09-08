// Collapses a burst of calls into at most one run per window, with a guaranteed trailing run: bounds staleness rather
// than call count. A debounce is wrong here, continuous calls would keep resetting its timer and it would never fire.
// The first call runs immediately; anything else in the window collapses into one run when it closes.
export const throttleTrailing = (fn: () => void, windowMs: number): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    // Holds the window open for windowMs after a run; a window that closes with nothing pending ends the chain, so an
    // idle workspace keeps no timer alive.
    const openWindow = (): void => {
        timer = setTimeout(() => {
            timer = undefined;
            if (!pending) {
                return;
            }
            pending = false;
            fn();
            openWindow();
        }, windowMs);
    };
    return () => {
        if (timer !== undefined) {
            pending = true;
            return;
        }
        fn();
        openWindow();
    };
};
