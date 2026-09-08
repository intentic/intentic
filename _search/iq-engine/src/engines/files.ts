import type { EngineHit } from "../types.js";
import { globToRegExp } from "../workspace/glob.js";

const BOUNDARY = new Set(["/", ".", "_", "-"]);

// Subsequence match score over a path, 0..1: a substring beats boundary-aligned and consecutive matches beats scattered
// ones; undefined means no match.
export const fuzzyScore = (needle: string, path: string): number | undefined => {
    const n = needle.toLowerCase();
    const h = path.toLowerCase();
    if (n.length === 0 || n.length > h.length) {
        return undefined;
    }
    const at = h.indexOf(n);
    if (at !== -1) {
        // Substring hits favor the basename and shorter paths; the score stays uncapped so length still breaks ties.
        const inBasename = at >= h.lastIndexOf("/") + 1;
        return 0.75 + (inBasename ? 0.2 : 0) + 5 / h.length;
    }
    let score = 0;
    let hi = 0;
    let previousHit = -2;
    for (let ni = 0; ni < n.length; ni++) {
        const ch = n[ni]!;
        let found = -1;
        while (hi < h.length) {
            if (h[hi] === ch) {
                found = hi;
                break;
            }
            hi++;
        }
        if (found === -1) {
            return undefined;
        }
        const boundary = found === 0 || BOUNDARY.has(h[found - 1]!) || (path[found] !== undefined && path[found]! >= "A" && path[found]! <= "Z");
        score += 1 + (found === previousHit + 1 ? 0.8 : 0) + (boundary ? 0.6 : 0);
        previousHit = found;
        hi = found + 1;
    }
    // Normalize against the best possible per-char score, damped by path length.
    return (score / (n.length * 2.4)) * 0.7 * Math.min(1, 20 / Math.max(20, h.length - n.length));
};

// No pattern lists every path in the sweep, sorted, never treated as an empty-result error. Only the `files` verb
// routes here; `q` calls fileSearch directly, where an empty pattern would flood fusion with every path.
export const filesVerbHits = (pattern: string, paths: readonly string[], glob: boolean): EngineHit[] =>
    pattern === ""
        ? paths.toSorted((a, b) => (a < b ? -1 : 1)).map((path) => ({ path, line: 1, text: path, tags: [{ kind: "path" as const }] }))
        : fileSearch(pattern, paths, glob);

// Filename search over the sweep's paths: fuzzy by default, exact globbing with `glob: true`. Hits are
// score-ranked; line 1 anchors the file itself.
export const fileSearch = (pattern: string, paths: readonly string[], glob: boolean): EngineHit[] => {
    if (glob) {
        const re = globToRegExp(pattern);
        return paths.filter((path) => re.test(path)).map((path) => ({ path, line: 1, text: path, tags: [{ kind: "path" as const }] }));
    }
    const scored: { path: string; score: number }[] = [];
    for (const path of paths) {
        const score = fuzzyScore(pattern, path);
        if (score !== undefined) {
            scored.push({ path, score });
        }
    }
    return scored
        .toSorted((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
        .map(({ path, score }) => ({
            path,
            line: 1,
            text: path,
            tags: [{ kind: "fuzzy" as const, score: Math.round(Math.min(1, score) * 100) / 100 }],
        }));
};
