import type { IqTag } from "@intentic/sandbox-contract";
import type { EngineResult, RankedGroup, RankedHit } from "../types.js";

const RRF_K = 60;
const DEF_BOOST = 1.5;
const PATH_BOOST = 1.25;
const RECENCY_HALF_LIFE_DAYS = 14;

export interface FuseContext {
    // Lowercased tokens from the query — hits in paths containing one get a boost.
    readonly queryTokens: readonly string[];
    readonly mtimes: ReadonlyMap<string, number>;
    readonly now: number;
    // The `boosts` feature toggle: false = pure RRF, no def/path/recency multipliers (benchmark baseline).
    readonly boosts: boolean;
}

const TAG_ORDER = ["def", "path", "fuzzy", "rerank", "sem", "bm25", "import", "call", "type", "write", "text", "heuristic"];

const dedupeTags = (tags: IqTag[]): IqTag[] => {
    const seen = new Map<string, IqTag>();
    for (const tag of tags) {
        const existing = seen.get(tag.kind);
        if (existing === undefined || (tag.score ?? 0) > (existing.score ?? 0)) {
            seen.set(tag.kind, tag);
        }
    }
    // Canonical order — output must not depend on which engine reported first.
    return [...seen.values()].toSorted((a, b) => TAG_ORDER.indexOf(a.kind) - TAG_ORDER.indexOf(b.kind));
};

// Reciprocal-rank fusion across engines, keyed by path:line, then relevance boosts and grouping by file.
// Deterministic: ties break by path then line, bytewise.
export const fuse = (results: readonly EngineResult[], context: FuseContext): RankedGroup[] => {
    const byKey = new Map<string, { path: string; line: number; text: string; start?: number; end?: number; tags: IqTag[]; score: number }>();
    for (const result of results) {
        result.hits.forEach((hit, rank) => {
            const key = `${hit.path}:${hit.line}`;
            const existing = byKey.get(key);
            const contribution = 1 / (RRF_K + rank + 1);
            if (existing === undefined) {
                byKey.set(key, {
                    path: hit.path,
                    line: hit.line,
                    text: hit.text,
                    ...(hit.start !== undefined ? { start: hit.start } : {}),
                    ...(hit.end !== undefined ? { end: hit.end } : {}),
                    tags: [...hit.tags],
                    score: contribution,
                });
                return;
            }
            existing.score += contribution;
            existing.tags.push(...hit.tags);
            // Prefer the richer snippet (one with char offsets) as the display text.
            if (existing.start === undefined && hit.start !== undefined) {
                existing.text = hit.text;
                existing.start = hit.start;
                existing.end = hit.end ?? hit.start;
            }
        });
    }
    const hits: RankedHit[] = [];
    for (const hit of byKey.values()) {
        let score = hit.score;
        if (context.boosts) {
            if (hit.tags.some((tag) => tag.kind === "def")) {
                score *= DEF_BOOST;
            }
            const pathLower = hit.path.toLowerCase();
            if (context.queryTokens.some((token) => pathLower.includes(token))) {
                score *= PATH_BOOST;
            }
            const mtime = context.mtimes.get(hit.path);
            if (mtime !== undefined) {
                const ageDays = Math.max(0, (context.now - mtime) / 86_400_000);
                score *= 1 + 0.2 * 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS);
            }
        }
        hits.push({ ...hit, tags: dedupeTags(hit.tags), score });
    }
    const byPath = new Map<string, RankedHit[]>();
    for (const hit of hits) {
        const list = byPath.get(hit.path);
        if (list === undefined) {
            byPath.set(hit.path, [hit]);
        } else {
            list.push(hit);
        }
    }
    const groups: RankedGroup[] = [];
    for (const [path, groupHits] of byPath) {
        const best = Math.max(...groupHits.map((hit) => hit.score));
        groups.push({
            path,
            score: best * (1 + 0.05 * Math.log(groupHits.length)),
            hits: groupHits.toSorted((a, b) => a.line - b.line),
        });
    }
    return groups.toSorted((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
};

export const queryTokens = (query: string): string[] => [...new Set(query.toLowerCase().match(/[a-z0-9_$]{3,}/g) ?? [])];
