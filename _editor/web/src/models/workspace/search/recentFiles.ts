import { fuzzyScore } from "@intentic/base/fuzzy";

// Quick-open's recency rule: the files this reader opened last, most recent first, and the ones a query matches listed
// above everything it ranks, since the file opened a minute ago is the likeliest answer to its own name typed again.
// After orca's quick-open history (MIT): 100 files a scope, matching ones first, in the order they were opened. Where
// the list is kept is recentFilesStore.ts.

/** How many files a sandbox remembers. */
export const KEEP = 100;

/** The list with `path` opened just now: moved to the front, never twice, the oldest falling off past KEEP. */
export const remembered = (recent: readonly string[], path: string): readonly string[] =>
    [path, ...recent.filter((entry) => entry !== path)].slice(0, KEEP);

/**
 * The ranked answer with the remembered files the query matches and `available` still offers lifted to its head, most
 * recently opened first, cut at `limit`. A remembered file that has since gone, or that the query misses, stays out.
 */
export const recentFirst = (
    query: string,
    ranked: readonly string[],
    recent: readonly string[],
    available: (path: string) => boolean,
    limit: number,
): readonly string[] => {
    const lifted = new Set(recent.filter((path) => available(path) && fuzzyScore(query, path) !== undefined));
    return lifted.size === 0 ? ranked.slice(0, limit) : [...lifted, ...ranked.filter((path) => !lifted.has(path))].slice(0, limit);
};
