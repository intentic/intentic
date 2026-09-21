// A dead chunk means a redeploy happened; recovery reloads onto the destination the user asked for.
// Matched on message wording across runtimes, not error class: a coding bug also throws TypeError.
// The per-target flag caps a genuinely dead chunk to one reload, cleared by any navigation that lands.

const CHUNK_RELOADED_KEY = `intentic.chunkReloaded`;
const STALE_CHUNK_MESSAGE =
    /error loading dynamically imported module|failed to fetch dynamically imported module|importing a module script failed|unable to preload css/i;

export const isStaleChunkError = (error: unknown): boolean => STALE_CHUNK_MESSAGE.test(String(error));

/** Answers a dead chunk with one reload landed on `target`. */
export const recoverStaleChunk = (target: string): boolean => {
    try {
        if (sessionStorage.getItem(CHUNK_RELOADED_KEY) === target) {
            return false;
        }
        sessionStorage.setItem(CHUNK_RELOADED_KEY, target);
    } catch {
        return false;
    }
    location.assign(target);
    return true;
};

/** Clears the guard once a chunk resolves, since this window's chunks evidently exist again. */
export const clearStaleChunkReload = (): void => {
    try {
        sessionStorage.removeItem(CHUNK_RELOADED_KEY);
    } catch {
        // No storage to clean.
    }
};

/**
 * A dynamic import nobody awaits: a terminal panel an agent surfaces mid-run, a model catalog reloaded after a turn
 * failed. `asyncView` hangs its recovery on the navigation that asked for the chunk; these have no navigation, so a
 * redeploy used to leave them rejecting into nothing — the panel never opened and the window stayed broken until the
 * reader happened to navigate. Answered here at the press instead, with the same one reload per destination.
 */
export const importOrReload = <T>(load: () => Promise<T>, use: (module: T) => unknown): void => {
    void load().then(
        (module) => {
            clearStaleChunkReload();
            // The module's own failure is a bug, not a redeploy, and must not be read as one.
            void Promise.resolve(use(module)).catch((error: unknown) => {
                console.error(`late import failed after loading`, error);
            });
        },
        (error: unknown) => {
            if (isStaleChunkError(error) && recoverStaleChunk(`${location.pathname}${location.search}`)) {
                return;
            }
            console.error(`late import failed`, error);
        },
    );
};
