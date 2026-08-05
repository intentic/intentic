/* Collapse a burst of calls into at most one run per window, WITH a guaranteed trailing run.
 *
 * Both call sites (the tree refetch in useWorkspaceLive, the `git status` refetch in useSandboxLiveness) are fed
 * by the daemon's file-watcher SSE, which emits a workspaceChanged batch every 250ms for as long as writes keep
 * landing — a dropped repo, an install, a build. A trailing DEBOUNCE is the wrong tool there: every batch would
 * reset its timer, so across minutes of continuous writes it would never fire at all and the panel would sit
 * frozen exactly when it has the most to show. A throttle bounds STALENESS instead of the call count: the first
 * call runs on the spot (a lone save still feels instant), everything arriving while the window is open collapses
 * into a single run when it closes, and that run opens the next window — so a storm costs one run per window, no
 * matter how long it lasts. */
export const throttleTrailing = (fn: () => void, windowMs: number): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    // Hold the window open for windowMs after a run. A window that closes with nothing pending ends the chain, so
    // an idle workspace keeps no timer alive and the next call runs immediately instead of waiting out a window.
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
