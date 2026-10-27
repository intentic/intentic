// The one answer to a lazy chunk that will not load. A dead chunk means a redeploy (or Vite re-optimizing deps under a
// live tab) happened: this window's asset names are gone, and the fix is the reload the reader would do by hand.
// Matched on message wording across runtimes, not error class, since a coding bug also throws TypeError, or on a stack
// that shows the page running two generations of the dev server's dependency bundle (below). One reload per destination
// per few minutes: a chunk that is still missing after the reload (an edge that cached its 404, 2026-10-27) then fails
// where the reader can see it instead of reloading the page every second, and a redeploy minutes later still gets its own
// reload. Other chunks loading says nothing about the one that failed, so it never re-arms the reload: that is what
// turned one cached 404 into an endless loop on /sandbox, the shell's chunk loading fine before every failed preload.
// The reload also asks the server again, past the browser's cache, for every file this page was refused: a 404 the
// browser kept (served "immutable" for a year, as that one was) would otherwise answer the reload too, however fixed the
// server is by then.

import { noteReload } from "./reloadReason";

const CHUNK_RELOADED_KEY = `intentic.chunkReloaded`;
// How long a destination's reload stays spent. Longer than any reload takes to come back and fail again; shorter than the
// gap between two deploys a reader would sit through on the same page.
const RELOAD_SPENT_MS = 5 * 60_000;
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

// The longest a reload waits on the refetches below; past it the page reloads with whatever they managed.
const REFETCH_WAIT_MS = 3_000;
const BUILD_FILE = /\.(?:m?js|css)(?:\?|$)/;

// This origin's scripts and stylesheets the page was refused, as Resource Timing saw them: it reports a refusal the
// browser answered from its own cache too, and it names the dependency that failed, where an import's error names only
// the chunk that was asked for. Engines without `responseStatus` (Firefox) report nothing here and just reload.
const refusedFiles = (): readonly string[] => {
    try {
        const urls = performance.getEntriesByType(`resource`).flatMap((entry) => {
            // SAFETY: entries of type `resource` are PerformanceResourceTiming; `responseStatus` is still read as optional.
            const status = (entry as PerformanceResourceTiming).responseStatus as number | undefined;
            return status !== undefined && status >= 400 && entry.name.startsWith(`${location.origin}/`) && BUILD_FILE.test(entry.name)
                ? [entry.name]
                : [];
        });
        return [...new Set(urls)];
    } catch {
        // allow(silent-catch): no Resource Timing means nothing to refetch, and the reload goes ahead as it would have
        return [];
    }
};

// `cache: reload` goes to the server and stores what it answers, replacing the refusal the browser kept.
const refetch = (urls: readonly string[]): Promise<void> => {
    const asked = Promise.all(
        urls.map((url) =>
            fetch(url, { cache: `reload` }).then(
                () => undefined,
                () => undefined,
            ),
        ),
    );
    return Promise.race([asked.then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, REFETCH_WAIT_MS))]);
};

// Whether this destination's reload started within RELOAD_SPENT_MS; the note is `<at>\n<target>`.
const reloadedRecently = (target: string): boolean => {
    const note = sessionStorage.getItem(CHUNK_RELOADED_KEY);
    if (note === null) {
        return false;
    }
    const split = note.indexOf(`\n`);
    const at = Number(note.slice(0, split));
    return split !== -1 && note.slice(split + 1) === target && Date.now() - at < RELOAD_SPENT_MS;
};

// How much of the refused list a report carries: enough for the handful a broken deploy leaves.
const REFUSED_REPORT_CHARS = 1_000;

/**
 * Reloads onto `target` (the page the reader is on by default), unless this destination had its reload in the last few
 * minutes or the tab has spent its budget of reloads nobody pressed for (reloadReason.ts).
 */
export const recoverStaleChunk = (target: string = here()): boolean => {
    try {
        if (reloadedRecently(target)) {
            return false;
        }
        sessionStorage.setItem(CHUNK_RELOADED_KEY, `${Date.now()}\n${target}`);
    } catch {
        // allow(silent-catch): storage access may be blocked in sandboxed contexts or private windows
        return false;
    }
    const refused = refusedFiles();
    const details = refused.length === 0 ? { target } : { target, refused: refused.join(` `).slice(0, REFUSED_REPORT_CHARS) };
    if (!noteReload(`stale-chunk`, details)) {
        // No reload from here, but the one the reader makes by hand then finds fresh copies of what this page was refused.
        if (refused.length > 0) {
            void refetch(refused);
        }
        return false;
    }
    if (refused.length === 0) {
        location.assign(target);
    } else {
        void refetch(refused).then(() => location.assign(target));
    }
    return true;
};

/**
 * Loads a lazy chunk. A dead one reloads the page once onto `target` (where the reader is, by default) and the promise
 * then never settles: the page is being replaced, so the caller keeps showing what it showed while loading instead of
 * flashing an error. Any other failure, or a dead chunk whose reload is spent or refused, rejects as it came. Never cache a
 * rejected `loadChunk` for the life of the tab: a later call is what retries.
 */
export const loadChunk = async <T>(load: () => Promise<T>, target?: string): Promise<T> => {
    try {
        return await load();
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
