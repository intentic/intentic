// The fzf-style path scorer both ends of quick-open rank with: the sandbox's file-name search (@intentic/text-search)
// and the app's own search box. One implementation, or the same keystrokes put a different file first depending on which one answered.

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

// The scorer over a needle and a path both already lowered; `path` keeps the original case for camelCase humps.
const foldedScore = (needle: string, haystack: string, path: string): number | undefined => {
    if (needle.length === 0 || needle.length > haystack.length) {
        return undefined;
    }
    const at = haystack.indexOf(needle);
    if (at !== -1) {
        return substringScore(haystack, at);
    }
    const raw = subsequenceScore(needle, haystack, path);
    // Normalized against the best possible per-char score, damped by path length.
    return raw === undefined ? undefined : (raw / (needle.length * 2.4)) * 0.7 * (20 / Math.max(20, haystack.length - needle.length));
};

/**
 * Scores a needle against a path, 0..~1, `undefined` when it does not match at all. A substring hit beats any
 * subsequence hit, and among subsequences the boundary-aligned and consecutive ones beat the scattered ones.
 */
export const fuzzyScore = (needle: string, path: string): number | undefined => foldedScore(needle.toLowerCase(), path.toLowerCase(), path);

/** Matching paths, best first, each with its score. */
export type Ranked = { readonly path: string; readonly score: number }[];

// Each path list's lowered copy, for a list ranked again as it stands (quick-open's, once per keystroke): lowering is
// a third of scoring a path. Kept from a list's second ranking on, since a list ranked once (the daemon lists afresh
// for every query) would only pay for the copy. Keyed by the list itself, as fuzzyRanker already is, so a list must
// not be changed in place between rankings; a list of another length is lowered afresh all the same.
const folded = new WeakMap<readonly string[], readonly string[]>();
const seen = new WeakSet<readonly string[]>();

const foldedOf = (paths: readonly string[]): readonly string[] | undefined => {
    const known = folded.get(paths);
    if (known !== undefined && known.length === paths.length) {
        return known;
    }
    if (!seen.has(paths)) {
        seen.add(paths);
        return undefined;
    }
    const lowered = paths.map((path) => path.toLowerCase());
    folded.set(paths, lowered);
    return lowered;
};

type Match = { path: string; score: number };

// The paths the needle matches, each with its score, in the order given; `lowered` is the list's lowered copy when
// there is one, else each path is lowered as it is read.
const matchesOf = (needle: string, paths: Iterable<string>, lowered: readonly string[] | undefined): Match[] => {
    const matched: Match[] = [];
    let id = 0;
    for (const path of paths) {
        const score = foldedScore(needle, lowered === undefined ? path.toLowerCase() : lowered[id]!, path);
        id++;
        if (score !== undefined) {
            matched.push({ path, score });
        }
    }
    return matched;
};

// Best first: the higher score, then the path. Two matches it cannot order are the same path at the same score, so
// which comes first never shows, and a heap and a sort agree on every answer.
const byRank = (a: Match, b: Match): number => b.score - a.score || (a.path < b.path ? -1 : 1);

// The `limit` matches that come first, unordered: a heap whose root is the worst kept, so N matches cost N log(limit)
// rather than a sort of all N.
const firstOf = (matched: readonly Match[], limit: number): Match[] => {
    const heap: Match[] = [];
    const worse = (a: number, b: number): boolean => byRank(heap[a]!, heap[b]!) > 0;
    const swap = (a: number, b: number): void => {
        [heap[a], heap[b]] = [heap[b]!, heap[a]!];
    };
    const siftUp = (from: number): void => {
        let child = from;
        while (child > 0 && worse(child, (child - 1) >> 1)) {
            swap(child, (child - 1) >> 1);
            child = (child - 1) >> 1;
        }
    };
    const siftDown = (from: number): void => {
        let at = from;
        for (;;) {
            let worst = at;
            for (const child of [2 * at + 1, 2 * at + 2]) {
                if (child < heap.length && worse(child, worst)) {
                    worst = child;
                }
            }
            if (worst === at) {
                return;
            }
            swap(at, worst);
            at = worst;
        }
    };
    for (const match of matched) {
        if (heap.length < limit) {
            heap.push(match);
            siftUp(heap.length - 1);
        } else if (limit > 0 && byRank(match, heap[0]!) < 0) {
            heap[0] = match;
            siftDown(0);
        }
    }
    return heap;
};

// The best `limit` of the matches, best first; all of them sorted in place when the limit covers them.
//
// 2026-11-24: replaced sorting every match and slicing, with every path lowered on every call. Best 50 of 500,000
// paths: one letter 275 ms → 49 ms on a list ranked before, 86 ms on one seen for the first time; "sess" 327 → 101 /
// 124 ms; 14,000 real paths, one letter 7.4 → 1.1 ms. The answer is the sort's, element for element, checked against
// the old ranking over 14,000 real and 500,000 paths.
const bestOf = (matched: Match[], limit: number): Ranked => (limit >= matched.length ? matched : firstOf(matched, limit)).sort(byRank);

/**
 * Every matching path, best first. Ties break on the path itself, so the order does not depend on the order the
 * paths arrived in — which is what lets two callers over the same set agree, and a test assert on the answer at all.
 */
export const rankByFuzzy = (needle: string, paths: Iterable<string>): Ranked => topByFuzzy(needle, paths, Infinity).ranked;

/** `rankByFuzzy`'s first `limit` paths, and how many matched in all. */
export interface TopRanked {
    readonly ranked: Ranked;
    readonly matched: number;
}

/** `rankByFuzzy`'s first `limit` paths, and how many matched in all, without ordering the ones past the limit. */
export const topByFuzzy = (needle: string, paths: Iterable<string>, limit: number): TopRanked => {
    const matched = matchesOf(needle.toLowerCase(), paths, Array.isArray(paths) ? foldedOf(paths) : undefined);
    return { ranked: bestOf(matched, limit), matched: matched.length };
};

/**
 * `rankByFuzzy` for a query typed a key at a time: while the paths are the same collection and the query only grew at
 * its end, only the last answer's paths are scored, since a path that misses a query misses every extension of it.
 * `limit` answers only the best that many, as `topByFuzzy` does; the paths past it are still kept for the next key.
 */
export const fuzzyRanker = (): ((needle: string, paths: readonly string[], limit?: number) => Ranked) => {
    let last: { readonly paths: readonly string[]; readonly needle: string; readonly matched: readonly Match[] } | undefined;
    return (needle, paths, limit = Infinity) => {
        const lowered = needle.toLowerCase();
        const narrowed = last !== undefined && last.paths === paths && last.needle !== "" && lowered.startsWith(last.needle);
        // A narrowed key lowers the few it reads; only a scan of the whole list counts as seeing it.
        const matched =
            narrowed && last !== undefined
                ? matchesOf(
                      lowered,
                      last.matched.map((match) => match.path),
                      undefined,
                  )
                : matchesOf(lowered, paths, foldedOf(paths));
        // Sorted in place when the limit covers it, so the next key's matches arrive in order and sort cheaply.
        const ranked = bestOf(matched, limit);
        last = { paths, needle: lowered, matched };
        return ranked;
    };
};
