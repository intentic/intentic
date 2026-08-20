/* THE STALE-WINDOW RECOVERY, as a fact both loaders share. A redeploy replaces every content-hashed chunk, so a
 * window opened before it holds an index.html whose lazy imports point at files that no longer exist. A failed
 * chunk load IS "this window is stale", and the answer is the reload the user would eventually perform by hand,
 * landed on the destination they asked for rather than the one they were leaving.
 *
 * It used to live inside router/index.ts because the router's onError hook was the only place a dead chunk
 * surfaced. Route-level views load through asyncView now (components/asyncView.ts), their failures happen
 * INSIDE an already-completed navigation, where no router hook ever sees them, so the detection and the
 * one-reload guard are one module with two callers instead of two drifting copies.
 *
 * Matched on the wording the runtimes actually produce (Chromium/Firefox/Safari phrase the import failure
 * differently, and Vite's own preload helper rethrows CSS failures with its own message) rather than on error
 * class, a TypeError is also what a coding bug inside a view throws, and reloading on those would turn any
 * real regression into a reload loop. The per-target flag is the loop guard for a chunk that is GENUINELY gone
 * (a broken deploy): one reload per destination, then the caller's own failure surface; cleared by any
 * navigation that lands, so the next redeploy gets its one reload again. */

const CHUNK_RELOADED_KEY = `intentic.chunkReloaded`;
const STALE_CHUNK_MESSAGE =
    /error loading dynamically imported module|failed to fetch dynamically imported module|importing a module script failed|unable to preload css/i;

export const isStaleChunkError = (error: unknown): boolean => STALE_CHUNK_MESSAGE.test(String(error));

/** Answer a dead chunk with one reload landed on `target`. Returns whether the reload was issued, `false`
 *  means this destination already got its one (or storage is unavailable, where the guard cannot hold and a
 *  possible reload loop is worse than the caller's own failure surface). */
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

/** A chunk RESOLVED: this window's chunks evidently exist, so the next redeploy earns its one reload again.
 *  Deliberately not "a navigation landed", asyncView makes every in-shell navigation land instantly, chunk or
 *  no chunk, so arrival stopped being evidence and clearing on it would turn a broken deploy into a reload
 *  loop (reload → land → clear → fail → reload …). */
export const clearStaleChunkReload = (): void => {
    try {
        sessionStorage.removeItem(CHUNK_RELOADED_KEY);
    } catch {
        // No storage to clean.
    }
};
