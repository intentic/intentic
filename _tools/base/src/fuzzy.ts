// The fzf-style path scorer both ends of quick-open rank with: the sandbox's iq `files` engine and the app's own
// search box. One implementation, or the same keystrokes put a different file first depending on which one answered.

// A character after one of these, or a camelCase hump, starts a "word" and is worth more than a mid-word hit.
const BOUNDARY = new Set(["/", ".", "_", "-"]);

// Substring hits favor the basename and shorter paths; uncapped, so length still breaks ties between two of them.
const substringScore = (haystack: string, at: number): number => 0.75 + (at >= haystack.lastIndexOf("/") + 1 ? 0.2 : 0) + 5 / haystack.length;

// The needle walked through the haystack left to right, consecutive and boundary-aligned hits worth more; undefined
// the moment a character has no occurrence left. `path` is the original case, which is where camelCase humps show.
const subsequenceScore = (needle: string, haystack: string, path: string): number | undefined => {
    let score = 0;
    let hi = 0;
    let previousHit = -2;
    for (let ni = 0; ni < needle.length; ni++) {
        const ch = needle[ni]!;
        const found = haystack.indexOf(ch, hi);
        if (found === -1) {
            return undefined;
        }
        const boundary =
            found === 0 || BOUNDARY.has(haystack[found - 1]!) || (path[found] !== undefined && path[found]! >= "A" && path[found]! <= "Z");
        score += 1 + (found === previousHit + 1 ? 0.8 : 0) + (boundary ? 0.6 : 0);
        previousHit = found;
        hi = found + 1;
    }
    return score;
};

/**
 * Scores a needle against a path, 0..~1, `undefined` when it does not match at all. A substring hit beats any
 * subsequence hit, and among subsequences the boundary-aligned and consecutive ones beat the scattered ones.
 */
export const fuzzyScore = (needle: string, path: string): number | undefined => {
    const n = needle.toLowerCase();
    const h = path.toLowerCase();
    if (n.length === 0 || n.length > h.length) {
        return undefined;
    }
    const at = h.indexOf(n);
    if (at !== -1) {
        return substringScore(h, at);
    }
    const raw = subsequenceScore(n, h, path);
    // Normalized against the best possible per-char score, damped by path length.
    return raw === undefined ? undefined : (raw / (n.length * 2.4)) * 0.7 * Math.min(1, 20 / Math.max(20, h.length - n.length));
};

/** Matching paths, best first, each with its score. */
export type Ranked = { readonly path: string; readonly score: number }[];

/**
 * Every matching path, best first. Ties break on the path itself, so the order does not depend on the order the
 * paths arrived in — which is what lets two callers over the same set agree, and a test assert on the answer at all.
 */
export const rankByFuzzy = (needle: string, paths: Iterable<string>): Ranked => {
    const scored: { path: string; score: number }[] = [];
    for (const path of paths) {
        const score = fuzzyScore(needle, path);
        if (score !== undefined) {
            scored.push({ path, score });
        }
    }
    return scored.toSorted((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
};

/**
 * `rankByFuzzy` for a query typed a key at a time: while the paths are the same collection and the query only grew at
 * its end, only the last answer's paths are scored, since a path that misses a query misses every extension of it.
 */
export const fuzzyRanker = (): ((needle: string, paths: readonly string[]) => Ranked) => {
    let last: { readonly paths: readonly string[]; readonly needle: string; readonly ranked: Ranked } | undefined;
    return (needle, paths) => {
        const narrowed =
            last !== undefined && last.paths === paths && last.needle !== "" && needle.toLowerCase().startsWith(last.needle.toLowerCase())
                ? last.ranked.map((entry) => entry.path)
                : paths;
        const ranked = rankByFuzzy(needle, narrowed);
        last = { paths, needle, ranked };
        return ranked;
    };
};
