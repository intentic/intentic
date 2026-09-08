// A dead chunk means a redeploy happened; recovery reloads onto the destination the user asked for.
// Matched on message wording across runtimes, not error class: a coding bug also throws TypeError.
// The per-target flag caps a genuinely dead chunk to one reload, cleared by any navigation that lands.

const CHUNK_RELOADED_KEY = `intentic.chunkReloaded`;
const STALE_CHUNK_MESSAGE =
    /error loading dynamically imported module|failed to fetch dynamically imported module|importing a module script failed|unable to preload css/i;

export const isStaleChunkError = (error: unknown): boolean => STALE_CHUNK_MESSAGE.test(String(error));

/**
 * Answers a dead chunk with one reload landed on `target`. Returns false if this destination already
 * got its reload, or if storage is unavailable and the guard can't hold.
 */
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

/**
 * Clears the guard once a chunk resolves, since this window's chunks evidently exist again. Not on
 * navigation landing: asyncView lands every navigation regardless of chunk, so arrival isn't evidence.
 */
export const clearStaleChunkReload = (): void => {
    try {
        sessionStorage.removeItem(CHUNK_RELOADED_KEY);
    } catch {
        // No storage to clean.
    }
};
