// The one answer to a lazy chunk that will not load. A dead chunk means a redeploy (or Vite re-optimizing deps under a
// live tab) happened: this window's asset names are gone, and the fix is the reload the reader would do by hand.
// Matched on message wording across runtimes, not error class, since a coding bug also throws TypeError, or on a stack
// that shows the page running two generations of the dev server's dependency bundle (below). A flag per
// destination caps a genuinely missing chunk to one reload, and any chunk that loads clears it: this window's assets
// evidently exist again, so the next redeploy earns its own reload.

import { noteReload } from "./reloadReason";

const CHUNK_RELOADED_KEY = `intentic.chunkReloaded`;
const STALE_CHUNK_MESSAGE =
    /error loading dynamically imported module|failed to fetch dynamically imported module|importing a module script failed|unable to preload css/i;

// One pre-bundled dependency as the dev server names it: its file under `.vite/deps` and the optimizer generation it
// belongs to.
const DEP_GENERATION = /\/\.vite\/deps\/([^?\s:)]+)\?v=([0-9a-f]+)/g;

// The same failure that did not fail to load. Vite re-bundling its dependencies under a live dev tab moves them to a new
// `?v=` hash; a module this tab first imports afterwards loads fine, against the NEW bundle, while everything already
// running holds the old one. The page then runs two copies of a dependency (two Vues: a component from one rendered by
// the other finds no current instance and throws on its first slot), and the error's stack is the only place both show:
// one file under two hashes. Never true in a production build, whose chunks carry no `?v=`.
const mixesDepGenerations = (stack: string): boolean => {
    const seen = new Map<string, string>();
    for (const [, file, generation] of stack.matchAll(DEP_GENERATION)) {
        if (file === undefined || generation === undefined) {
            continue;
        }
        const known = seen.get(file);
        if (known !== undefined && known !== generation) {
            return true;
        }
        seen.set(file, generation);
    }
    return false;
};

export const isStaleChunkError = (error: unknown): boolean =>
    STALE_CHUNK_MESSAGE.test(String(error)) || (error instanceof Error && error.stack !== undefined && mixesDepGenerations(error.stack));

const here = (): string => `${location.pathname}${location.search}`;

/** Reloads onto `target` (the page the reader is on by default), unless this destination already had its one reload. */
export const recoverStaleChunk = (target: string = here()): boolean => {
    try {
        if (sessionStorage.getItem(CHUNK_RELOADED_KEY) === target) {
            return false;
        }
        sessionStorage.setItem(CHUNK_RELOADED_KEY, target);
    } catch {
        // allow(silent-catch): storage access may be blocked in sandboxed contexts or private windows
        return false;
    }
    noteReload(`stale-chunk`);
    location.assign(target);
    return true;
};

const clearStaleChunkReload = (): void => {
    try {
        sessionStorage.removeItem(CHUNK_RELOADED_KEY);
    } catch {
        // allow(silent-catch): no storage to clean in sandboxed contexts or private windows
    }
};

/**
 * Loads a lazy chunk. A dead one reloads the page once onto `target` (where the reader is, by default) and the promise
 * then never settles: the page is being replaced, so the caller keeps showing what it showed while loading instead of
 * flashing an error. Any other failure, or a dead chunk whose one reload is spent, rejects as it came. Never cache a
 * rejected `loadChunk` for the life of the tab: a later call is what retries.
 */
export const loadChunk = async <T>(load: () => Promise<T>, target?: string): Promise<T> => {
    try {
        const module = await load();
        clearStaleChunkReload();
        return module;
    } catch (error) {
        if (isStaleChunkError(error) && recoverStaleChunk(target)) {
            return new Promise<T>(() => undefined);
        }
        throw error;
    }
};

/**
 * The safety net under every import no caller wrapped: Vite reports a failed preload of a dynamic import's
 * dependencies as `vite:preloadError` on `window`. Answered with the same one reload per destination; when that reload
 * goes ahead the event is cancelled, so the import does not also throw into a page that is leaving.
 */
export const installChunkRecovery = (target: Window = window): void => {
    target.addEventListener(`vite:preloadError`, (event) => {
        if (recoverStaleChunk()) {
            event.preventDefault();
        }
    });
};
