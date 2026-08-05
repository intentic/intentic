/* fzf-style subsequence scoring over workspace paths — the client half of quick-open. Deliberately the same
 * ranking model as the sandbox's iq `files` engine (_search/iq-engine/src/engines/files.ts), kept in sync by
 * copy rather than import: iq is a dependency island nothing may import (see ARCHITECTURE.md). */

const BOUNDARY = new Set([`/`, `.`, `_`, `-`]);

// Score a needle against one path, 0..~1 (uncapped substring bonus so length still breaks ties). Substring
// matches score highest (basename beats dir, shorter beats longer); otherwise boundary-aligned and consecutive
// subsequence hits beat scattered ones. undefined = not a match.
export const fuzzyScore = (needle: string, path: string): number | undefined => {
    const n = needle.toLowerCase();
    const h = path.toLowerCase();
    if (n.length === 0 || n.length > h.length) {
        return undefined;
    }
    const at = h.indexOf(n);
    if (at !== -1) {
        const inBasename = at >= h.lastIndexOf(`/`) + 1;
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
        const boundary = found === 0 || BOUNDARY.has(h[found - 1]!) || (path[found] !== undefined && path[found]! >= `A` && path[found]! <= `Z`);
        score += 1 + (found === previousHit + 1 ? 0.8 : 0) + (boundary ? 0.6 : 0);
        previousHit = found;
        hi = found + 1;
    }
    // Normalize against the best possible per-char score, damped by path length.
    return (score / (n.length * 2.4)) * 0.7 * Math.min(1, 20 / Math.max(20, h.length - n.length));
};

// The query's best matches over the workspace paths: score desc, then path asc for determinism, capped at limit.
export const rankPaths = (query: string, paths: readonly string[], limit: number): string[] => {
    const scored: { path: string; score: number }[] = [];
    for (const path of paths) {
        const score = fuzzyScore(query, path);
        if (score !== undefined) {
            scored.push({ path, score });
        }
    }
    return scored
        .toSorted((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
        .slice(0, limit)
        .map((entry) => entry.path);
};
