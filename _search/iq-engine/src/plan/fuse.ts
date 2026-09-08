import type { WorkspaceSearchSpan, WorkspaceSearchTag } from "@intentic/sandbox-contract";
import type { FileClass, EngineResult, RankedGroup, RankedHit } from "../types.js";
import { classOf } from "../workspace/scan.js";
import { pathTokens } from "./tokens.js";

const RRF_K = 60;
const DEF_BOOST = 1.5;
const PATH_BOOST = 1.25;
const RECENCY_HALF_LIFE_DAYS = 14;

// Class prior for natural-language answers only; exact verbs (find/refs/def) skip it, a test hit counts fully.
const CLASS_PRIOR: Record<FileClass, number> = { src: 1, config: 0.9, tests: 0.75, docs: 0.7 };

export interface FuseContext {
    // The query's content words; a hit whose path is named after one gets a boost.
    readonly queryTokens: readonly string[];
    readonly mtimes: ReadonlyMap<string, number>;
    readonly now: number;
    // The three fusion multipliers, each its own feature toggle: all off = pure RRF (benchmark baseline).
    readonly defBoost: boolean;
    readonly pathBoost: boolean;
    readonly recency: boolean;
    // Prefer implementation over tests/docs/config, natural-language queries only.
    readonly sourceFirst: boolean;
}

const TAG_ORDER = ["def", "path", "fuzzy", "rerank", "sem", "bm25", "import", "call", "type", "write", "text", "heuristic"];

const dedupeTags = (tags: WorkspaceSearchTag[]): WorkspaceSearchTag[] => {
    const seen = new Map<string, WorkspaceSearchTag>();
    for (const tag of tags) {
        const existing = seen.get(tag.kind);
        if (existing === undefined || (tag.score ?? 0) > (existing.score ?? 0)) {
            seen.set(tag.kind, tag);
        }
    }
    // Canonical order, output must not depend on which engine reported first.
    return [...seen.values()].toSorted((a, b) => TAG_ORDER.indexOf(a.kind) - TAG_ORDER.indexOf(b.kind));
};

// Reciprocal-rank fusion across engines, keyed by path:line, then relevance boosts and grouping by file.
// Deterministic: ties break by path then line, bytewise.
export const fuse = (results: readonly EngineResult[], context: FuseContext): RankedGroup[] => {
    const byKey = new Map<
        string,
        { path: string; line: number; text: string; spans?: readonly WorkspaceSearchSpan[]; tags: WorkspaceSearchTag[]; score: number }
    >();
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
                    ...(hit.spans !== undefined ? { spans: hit.spans } : {}),
                    tags: [...hit.tags],
                    score: contribution,
                });
                return;
            }
            existing.score += contribution;
            existing.tags.push(...hit.tags);
            // Prefer the richer snippet (one that knows which spans matched) as the display text.
            if (existing.spans === undefined && hit.spans !== undefined) {
                existing.text = hit.text;
                existing.spans = hit.spans;
            }
        });
    }
    // A path names the query when a path token starts with a query token (`indexer.ts` answers "index"); memoized.
    const named = new Map<string, boolean>();
    const namesQuery = (path: string): boolean => {
        const cached = named.get(path);
        if (cached !== undefined) {
            return cached;
        }
        const match = pathTokens(path).some((part) => context.queryTokens.some((token) => part.startsWith(token)));
        named.set(path, match);
        return match;
    };
    const hits: RankedHit[] = [];
    for (const hit of byKey.values()) {
        let score = hit.score;
        if (context.defBoost && hit.tags.some((tag) => tag.kind === "def")) {
            score *= DEF_BOOST;
        }
        if (context.pathBoost && namesQuery(hit.path)) {
            score *= PATH_BOOST;
        }
        const mtime = context.recency ? context.mtimes.get(hit.path) : undefined;
        if (mtime !== undefined) {
            const ageDays = Math.max(0, (context.now - mtime) / 86_400_000);
            score *= 1 + 0.2 * 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS);
        }
        if (context.sourceFirst) {
            score *= CLASS_PRIOR[classOf(hit.path)];
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
    // Any engine that stopped short on a file marks it for every engine: the group's hits are a floor either way.
    const capped = new Set(results.flatMap((result) => [...(result.capped ?? [])]));
    const groups: RankedGroup[] = [];
    for (const [path, groupHits] of byPath) {
        // Reduced, not spread: a path can accumulate unbounded hits, and spread costs one stack frame per hit.
        const best = groupHits.reduce((max, hit) => (hit.score > max ? hit.score : max), Number.NEGATIVE_INFINITY);
        groups.push({
            path,
            score: best * (1 + 0.05 * Math.log(groupHits.length)),
            hits: groupHits.toSorted((a, b) => a.line - b.line),
            ...(capped.has(path) ? { capped: true } : {}),
        });
    }
    return groups.toSorted((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
};
