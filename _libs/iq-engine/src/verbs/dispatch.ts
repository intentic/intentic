import type { WorkspaceSearchFreshness, WorkspaceSearchGroup, WorkspaceSearchResult } from "@intentic/sandbox-contract";
import type { Embedder } from "../embed/embedder.js";
import type { Reranker } from "../embed/reranker.js";
import { astSearch } from "../engines/astq.js";
import { bm25Search, prfTerms } from "../engines/bm25.js";
import { fileSearch } from "../engines/files.js";
import { logSearch, recentFiles, whoAnchor } from "../engines/git.js";
import { rgSearch } from "../engines/lexical.js";
import { embedPending, semanticSearch } from "../engines/semantic.js";
import { defOf, refsOf, symSearch } from "../engines/symbols.js";
import { disabledOf, type Feature } from "../features.js";
import { classify } from "../plan/classify.js";
import { fuse, type FuseContext, queryTokens } from "../plan/fuse.js";
import { cursorId, decodeCursor, readSpool, writeSpool } from "../render/cursor.js";
import { renderText, type Rendered } from "../render/text.js";
import type { IndexDb } from "../store/db.js";
import type { EngineHit, EngineResult, FileEntry, QueryOutcome, QueryRequest, RankedGroup, RankedHit, Verb } from "../types.js";
import { filterScope, langOf, sweep } from "../workspace/scan.js";
import { contextOf, outlineOf, parseAnchor } from "./context.js";

export interface DispatchContext {
    readonly root: string;
    readonly indexDir: string;
    readonly db: IndexDb;
    readonly generation: number;
    // How current the index is relative to disk, as of this query — the caller knows (the CLI just revalidated:
    // fresh; the resident engine may be mid-revalidation: building/stale).
    readonly freshness: WorkspaceSearchFreshness;
    readonly getEmbedder: () => Promise<Embedder | undefined>;
    readonly getReranker: () => Promise<Reranker | undefined>;
    readonly features: ReadonlySet<Feature>;
    readonly rgPath?: string;
    // Aborts cancellable work (the rg child) when the caller's request dies mid-query.
    readonly signal?: AbortSignal;
}

interface VerbPlan {
    readonly groups: RankedGroup[];
    readonly unit: string;
    readonly style: "hits" | "paths" | "plain";
    readonly showTags: boolean;
    readonly hint?: string;
    readonly headerNote?: string;
    readonly related?: string[];
    readonly candidates?: readonly string[];
}

// Compact ranked path map for ask/q — how far down the model can scan to a candidate that ranked below the
// packed/shown groups.
const CANDIDATE_COUNT = 12;
const candidatesOf = (groups: readonly RankedGroup[]): string[] => groups.slice(0, CANDIDATE_COUNT).map((group) => group.path);

const toGroups = (results: EngineResult[], query: string, entries: readonly FileEntry[], boosts: boolean): RankedGroup[] => {
    const context: FuseContext = {
        queryTokens: queryTokens(query),
        mtimes: new Map(entries.map((entry) => [entry.path, entry.mtimeMs])),
        now: Date.now(),
        boosts,
    };
    return fuse(results, context);
};

// Group already-ranked hits by file, preserving engine order (a group's rank = its best hit's rank). Shared by
// the fuzzy verbs (sym, def-fallback) that rank hits directly instead of fusing engines.
const groupByPath = (hits: readonly EngineHit[]): RankedGroup[] => {
    const byPath = new Map<string, { path: string; score: number; hits: RankedHit[] }>();
    hits.forEach((hit, rank) => {
        const scored = { ...hit, score: 1 / (rank + 1) };
        const existing = byPath.get(hit.path);
        if (existing === undefined) {
            byPath.set(hit.path, { path: hit.path, score: scored.score, hits: [scored] });
        } else {
            existing.hits.push(scored);
        }
    });
    return [...byPath.values()].map((group) => {
        group.hits.sort((a, b) => a.line - b.line);
        return group;
    });
};

interface FileSymbolRange {
    readonly name: string;
    readonly kind: string;
    readonly line: number;
    readonly endLine: number;
}

const symbolsOf = (db: IndexDb, cache: Map<string, FileSymbolRange[]>, path: string): FileSymbolRange[] => {
    const cached = cache.get(path);
    if (cached !== undefined) {
        return cached;
    }
    const rows = db
        .all("SELECT s.name, s.kind, s.line, s.end_line FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ?", path)
        .map((row) => ({ name: row["name"] as string, kind: row["kind"] as string, line: Number(row["line"]), endLine: Number(row["end_line"]) }));
    cache.set(path, rows);
    return rows;
};

const enclosingSymbol = (db: IndexDb, cache: Map<string, FileSymbolRange[]>, path: string, line: number): FileSymbolRange | undefined =>
    symbolsOf(db, cache, path)
        .filter((symbol) => symbol.line <= line && symbol.endLine >= line)
        .toSorted((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];

// symctx: parent-document context — every line-anchored hit learns its enclosing symbol, so the reading agent
// often needs no follow-up `iq context`/Read. Def-tagged hits skip it (they ARE the symbol).
const enrichContext = (db: IndexDb, groups: readonly RankedGroup[]): void => {
    const cache = new Map<string, FileSymbolRange[]>();
    for (const group of groups) {
        for (const hit of group.hits) {
            if (hit.tags.some((tag) => tag.kind === "def")) {
                continue;
            }
            const symbol = enclosingSymbol(db, cache, hit.path, hit.line);
            if (symbol !== undefined) {
                hit.context = `${symbol.name} (${symbol.kind})`;
            }
        }
    }
};

const RELATED_TOP = 3;

// graph: code-graph neighbors of the answer — the top hits' enclosing symbols as definition anchors with
// ready-made follow-up commands (GraphRAG-lite over the symbol table, zero extra processes).
const relatedOf = (db: IndexDb, groups: readonly RankedGroup[]): string[] => {
    const cache = new Map<string, FileSymbolRange[]>();
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const group of groups.slice(0, RELATED_TOP)) {
        const hit = group.hits[0];
        if (hit === undefined) {
            continue;
        }
        const symbol = enclosingSymbol(db, cache, hit.path, hit.line);
        if (symbol === undefined || seen.has(symbol.name)) {
            continue;
        }
        seen.add(symbol.name);
        lines.push(`${symbol.name} — def ${hit.path}:${symbol.line} · refs: iq refs ${symbol.name}`);
    }
    return lines;
};

interface Chunk {
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string;
}

const chunkAt = (db: IndexDb, path: string, line: number): Chunk | undefined => {
    const row = db.get(
        "SELECT c.start_line, c.end_line, c.text FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.path = ? AND c.start_line <= ? AND c.end_line >= ? LIMIT 1",
        path,
        line,
        line,
    );
    if (row === undefined) {
        return undefined;
    }
    return { startLine: Number(row["start_line"]), endLine: Number(row["end_line"]), text: String(row["text"] ?? "") };
};

const PACK_TOP = 2;

// pack: the top groups arrive as the actual code slice, not a pointer — the enclosing chunk of each group's
// best hit becomes per-line hits, so the reading agent usually skips the follow-up Read that transcript
// analytics showed on every iq answer. The budget renderer's per-group cap still shapes the slice.
const packGroups = (db: IndexDb, groups: readonly RankedGroup[]): RankedGroup[] =>
    groups.map((group, index) => {
        if (index >= PACK_TOP) {
            return group;
        }
        const anchor = group.hits.toSorted((a, b) => b.score - a.score)[0];
        if (anchor === undefined) {
            return group;
        }
        const chunk = chunkAt(db, group.path, anchor.line);
        if (chunk === undefined) {
            return group;
        }
        const lines = chunk.text.split("\n");
        if (lines.at(-1) === "") {
            lines.pop();
        }
        const hits = lines.map((text, offset): RankedHit => {
            const line = chunk.startLine + offset;
            if (line === anchor.line) {
                return Object.assign({}, anchor, { text });
            }
            return { path: group.path, line, text, tags: [], score: 0 };
        });
        return { path: group.path, score: group.score, hits };
    });

const ANCHOR_VERBS = new Set<Verb>(["outline", "context", "recent", "log", "who"]);

// grep escapes metachars that rust regex takes literally — `a\|b` matches the text "a|b", not "a or b". Agents
// reflexively write this (benchmarked: the single most common wasted query), so it's worth catching proactively.
const GREP_DIALECT = /\\[|+?(){}]/;
const GREP_DIALECT_NOTE = "pattern has grep-style escapes — iq uses rust regex: alternation is a|b (no backslash); literal text: --literal";

// Zero hits must never be a dead end — benchmarked at a 31% zero-hit rate, each one a wasted agent turn.
// Diagnose the probable cause in priority order: grep-dialect regex, over-narrow scope, then rephrasing.
const zeroHitHint = (request: QueryRequest): string | undefined => {
    if (ANCHOR_VERBS.has(request.verb)) {
        return undefined;
    }
    if (GREP_DIALECT.test(request.query)) {
        return `0 hits and the ${GREP_DIALECT_NOTE}`;
    }
    const scope = request.scope;
    if (scope.langs !== undefined || scope.paths !== undefined || scope.globs !== undefined || scope.only !== undefined) {
        return "0 hits — scope may be too narrow: retry without --lang/--in/--glob/--only";
    }
    if (request.verb === "def" || request.verb === "refs") {
        return `0 hits — names are exact here; try iq sym '${request.query}*' or iq find ${request.query}`;
    }
    if (request.verb === "ask" || (request.verb === "q" && classify(request.query) === "natural")) {
        return "0 hits — rephrase, or search literal text with iq find 'exact text'";
    }
    return `0 hits — try auto mode: iq "${request.query.slice(0, 60)}" or a natural question via iq ask`;
};

const RERANK_TOP = 32;
// RRF constant for blending the fused order with the cross-encoder order — same k as plan/fuse.ts.
const RERANK_RRF_K = 60;
// Below this sigmoid gap between the best and second-best passage, the field is flat enough to tell the model so.
const CONFIDENCE_MARGIN = 0.05;

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

// Cross-encoder pass over the fused top hits: score each candidate's full chunk text against the query, then
// BLEND that ordering with the fused one via RRF — the web-trained cross-encoder is a strong reorderer but a
// poor judge of code irrelevance (it prefers prose about a thing over the thing), so it votes, never dictates:
// benchmarked, rerank-dominates cost 0.10 recall@10 by evicting correct code below the cutoff. Hits beyond the
// rerank window keep their fused order after the blended ones.
const rerankGroups = async (
    db: IndexDb,
    reranker: Reranker,
    query: string,
    groups: RankedGroup[],
): Promise<{ groups: RankedGroup[]; best: number; margin: number }> => {
    const candidates: RankedHit[] = [];
    for (const group of groups) {
        for (const hit of group.hits) {
            if (candidates.length >= RERANK_TOP) {
                break;
            }
            candidates.push(hit);
        }
    }
    const passages = candidates.map((hit) => chunkAt(db, hit.path, hit.line)?.text ?? hit.text);
    const scores = await reranker.rerank(query, passages);
    const scoredKeys = new Set(candidates.map((hit) => `${hit.path}:${hit.line}`));
    // Candidate index IS its fused rank (candidates were taken in fused order).
    const scored = candidates.map((hit, fusedRank) => {
        const tag = { kind: "rerank" as const, score: Math.round(sigmoid(scores[fusedRank]!) * 100) / 100 };
        return { hit: Object.assign({}, hit, { tags: [...hit.tags, tag] }), fusedRank, logit: scores[fusedRank]! };
    });
    const rerankRanks = new Map(
        scored.toSorted((a, b) => b.logit - a.logit || a.fusedRank - b.fusedRank).map((entry, rank) => [entry.fusedRank, rank] as const),
    );
    const rrf = (entry: (typeof scored)[number]): number =>
        1 / (RERANK_RRF_K + entry.fusedRank) + 1 / (RERANK_RRF_K + rerankRanks.get(entry.fusedRank)!);
    const blended = scored.toSorted((a, b) => rrf(b) - rrf(a) || a.fusedRank - b.fusedRank).map((entry) => entry.hit);
    const rest = groups.flatMap((group) => group.hits).filter((hit) => !scoredKeys.has(`${hit.path}:${hit.line}`));
    // Regroup by path in the new order: a group's rank = its best hit's rank.
    const byPath = new Map<string, { path: string; score: number; hits: RankedHit[] }>();
    [...blended, ...rest].forEach((hit, rank) => {
        const score = 1 / (rank + 1);
        const existing = byPath.get(hit.path);
        if (existing === undefined) {
            byPath.set(hit.path, { path: hit.path, score, hits: [hit] });
        } else {
            existing.hits.push(hit);
        }
    });
    const regrouped = [...byPath.values()].map((group) => {
        group.hits.sort((a, b) => a.line - b.line);
        return group;
    });
    // Confidence is RELATIVE, not absolute: ms-marco scores correct code low across the board, so "does the best
    // passage stand out from the field" (margin) separates a clear winner from a flat, genuinely-ambiguous set —
    // whereas the raw top score flags even a correct rank-1 answer.
    const sorted = scores.map(sigmoid).toSorted((a, b) => b - a);
    return { groups: regrouped, best: sorted[0] ?? 0, margin: (sorted[0] ?? 0) - (sorted[1] ?? 0) };
};

const runVerb = async (context: DispatchContext, request: QueryRequest, entries: readonly FileEntry[]): Promise<VerbPlan> => {
    const on = (feature: Feature): boolean => context.features.has(feature);
    const boosts = on("boosts");
    const allowed = new Set(entries.map((entry) => entry.path));
    const paths = entries.map((entry) => entry.path);
    const rgBase = {
        root: context.root,
        allowed,
        ...(request.scope.ignored ? { ignored: true } : {}),
        ...(context.rgPath !== undefined ? { rgPath: context.rgPath } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
    };

    if (request.verb === "find") {
        const hits = await rgSearch({
            ...rgBase,
            pattern: request.query,
            ...(request.options.literal ? { literal: true } : {}),
            ...(request.options.word ? { word: true } : {}),
            ...(request.options.caseSensitive ? { caseSensitive: true } : {}),
        });
        // Warn about grep-dialect escapes up front — even when they accidentally matched something — so the agent
        // doesn't have to hit zero results to learn the pattern was wrong.
        const dialectNote = !request.options.literal && GREP_DIALECT.test(request.query) ? GREP_DIALECT_NOTE : undefined;
        return {
            groups: toGroups([{ engine: "lexical", hits }], request.query, entries, boosts),
            unit: "matches",
            style: "hits",
            showTags: false,
            ...(dialectNote !== undefined ? { headerNote: dialectNote } : {}),
        };
    }

    if (request.verb === "files") {
        const hits = fileSearch(request.query, paths, request.options.globExact === true);
        // Preserve the engine's own ranking: each file is its own group, scored by rank.
        const groups = hits.map((hit, rank) => ({ path: hit.path, score: 1 / (rank + 1), hits: [{ ...hit, score: 1 / (rank + 1) }] }));
        return { groups, unit: "files", style: "paths", showTags: true };
    }

    if (request.verb === "def") {
        const hits = defOf(context.db, request.query, allowed);
        if (hits.length > 0) {
            const groups = toGroups([{ engine: "symbols", hits }], request.query, entries, boosts);
            return { groups, unit: "definitions", style: "hits", showTags: true, hint: `refs: iq refs ${request.query}` };
        }
        // No exact definition — fall back to a fuzzy symbol match instead of a dead end (the query is often a
        // concept, not a symbol, or a near-miss on the name). Empty here means genuinely nothing.
        const fuzzy = symSearch(context.db, request.query, undefined, allowed);
        const groups = groupByPath(fuzzy);
        return {
            groups,
            unit: "symbols",
            style: "hits",
            showTags: true,
            ...(groups.length > 0 ? { headerNote: `no exact definition of "${request.query}" — showing fuzzy symbol matches` } : {}),
        };
    }

    if (request.verb === "sym") {
        const hits = symSearch(context.db, request.query, request.options.symKind, allowed);
        return { groups: groupByPath(hits), unit: "symbols", style: "hits", showTags: true };
    }

    if (request.verb === "refs") {
        const { hits, hint } = await refsOf(context.db, request.query, request.options.refKind, rgBase);
        return {
            groups: toGroups([{ engine: "refs", hits }], request.query, entries, boosts),
            unit: "refs",
            style: "hits",
            showTags: true,
            ...(hint !== undefined ? { hint } : {}),
        };
    }

    if (request.verb === "ast") {
        if (request.options.astLang === undefined) {
            throw new Error("iq ast: --lang is required (the pattern's parse language)");
        }
        const hits = await astSearch(request.query, request.options.astLang, entries);
        return { groups: toGroups([{ engine: "ast", hits }], request.query, entries, boosts), unit: "matches", style: "hits", showTags: false };
    }

    if (request.verb === "outline") {
        const groups = await outlineOf(context.db, context.root, request.query);
        return { groups, unit: "entries", style: "hits", showTags: true };
    }

    if (request.verb === "context") {
        const { groups, label } = await contextOf(context.db, context.root, request.query, request.render.contextLines ?? 0);
        return { groups, unit: "lines", style: "hits", showTags: false, headerNote: label };
    }

    if (request.verb === "recent") {
        const groups = await recentFiles(context.root, entries, {
            ...(request.options.since !== undefined ? { since: request.options.since } : {}),
            ...(request.options.author !== undefined ? { author: request.options.author } : {}),
            ...(request.query !== "" ? { pattern: request.query } : {}),
        });
        return { groups, unit: "files", style: "paths", showTags: false };
    }

    if (request.verb === "log") {
        const groups = await logSearch(context.root, entries, request.query, {
            ...(request.options.logRegex !== undefined ? { regex: request.options.logRegex } : {}),
            ...(request.options.since !== undefined ? { since: request.options.since } : {}),
            ...(request.options.author !== undefined ? { author: request.options.author } : {}),
            ...(request.options.path !== undefined ? { path: request.options.path } : {}),
        });
        return { groups, unit: "commits", style: "plain", showTags: false };
    }

    if (request.verb === "who") {
        const groups = await whoAnchor(context.root, entries, parseAnchor(request.query));
        return { groups, unit: "commits", style: "plain", showTags: false };
    }

    if (request.verb === "ask") {
        const results: EngineResult[] = [];
        const notes: string[] = [];
        if (on("bm25")) {
            results.push({ engine: "bm25", hits: bm25Search(context.db, request.query, allowed) });
            if (on("prf")) {
                // RM3: the expanded query enters fusion as its own engine, so original-query ranks keep weight.
                const expansion = prfTerms(context.db, request.query);
                if (expansion.length > 0) {
                    results.push({ engine: "bm25prf", hits: bm25Search(context.db, `${request.query} ${expansion.join(" ")}`, allowed) });
                }
            }
        }
        const embedder = on("semantic") ? await context.getEmbedder() : undefined;
        if (embedder === undefined) {
            notes.push(on("semantic") ? "no embedding backend — BM25 only" : "semantic off");
        } else {
            const remaining = await embedPending(context.db, embedder);
            results.push({ engine: "semantic", hits: semanticSearch(context.db, await embedder.embedQuery(request.query), allowed) });
            if (remaining > 0) {
                const total = Number(context.db.get("SELECT COUNT(*) AS n FROM chunks")?.["n"] ?? 0);
                notes.push(`embeddings ${Math.floor(((total - remaining) / Math.max(1, total)) * 100)}%`);
            }
        }
        let groups = toGroups(results, request.query, entries, boosts);
        const reranker = on("rerank") ? await context.getReranker() : undefined;
        if (reranker !== undefined && groups.length > 0) {
            const { groups: rerankedGroups, margin } = await rerankGroups(context.db, reranker, request.query, groups);
            groups = rerankedGroups;
            notes.push("reranked");
            // Flat field = no clear winner: keep the model IN iq, pointing at the candidate list, never steering it
            // out to a grep-guessing spiral (benchmarked: the old "try iq find" note made models abandon a rank-1 hit).
            if (on("confidence") && margin < CONFIDENCE_MARGIN) {
                notes.push("top results are close — scan the candidates below; the answer may be any of the top few");
            }
        }
        const related = on("graph") ? relatedOf(context.db, groups) : [];
        return {
            groups,
            unit: "hits",
            style: "hits",
            showTags: true,
            ...(notes.length > 0 ? { headerNote: notes.join(" · ") } : {}),
            ...(related.length > 0 ? { related } : {}),
            ...(groups.length > 1 ? { candidates: candidatesOf(groups) } : {}),
        };
    }

    if (request.verb === "q") {
        const kind = classify(request.query);
        const results: EngineResult[] = [];
        if (kind === "path") {
            results.push({ engine: "files", hits: fileSearch(request.query, paths, /[*?[]/.test(request.query)) });
            results.push({ engine: "lexical", hits: await rgSearch({ ...rgBase, pattern: request.query, literal: true }) });
        } else if (kind === "identifier") {
            results.push({ engine: "symbols", hits: defOf(context.db, request.query, allowed) });
            // rg keeps exhaustive precision (existence of every occurrence); BM25 supplies the relevance rank.
            results.push({ engine: "lexical", hits: await rgSearch({ ...rgBase, pattern: request.query, word: true }) });
            if (on("bm25")) {
                results.push({ engine: "bm25", hits: bm25Search(context.db, request.query, allowed) });
            }
        } else if (kind === "regex") {
            results.push({ engine: "lexical", hits: await rgSearch({ ...rgBase, pattern: request.query }) });
        } else {
            if (on("bm25")) {
                results.push({ engine: "bm25", hits: bm25Search(context.db, request.query, allowed) });
                if (on("prf")) {
                    const expansion = prfTerms(context.db, request.query);
                    if (expansion.length > 0) {
                        results.push({ engine: "bm25prf", hits: bm25Search(context.db, `${request.query} ${expansion.join(" ")}`, allowed) });
                    }
                }
            }
            const embedder = on("semantic") ? await context.getEmbedder() : undefined;
            if (embedder !== undefined) {
                results.push({ engine: "semantic", hits: semanticSearch(context.db, await embedder.embedQuery(request.query), allowed) });
            }
        }
        const groups = toGroups(results, request.query, entries, boosts);
        // Natural-language bare queries get the same scannable candidate map as `ask` (they're packed too).
        return {
            groups,
            unit: "hits",
            style: "hits",
            showTags: true,
            ...(kind === "natural" && groups.length > 1 ? { candidates: candidatesOf(groups) } : {}),
        };
    }

    throw new Error(`iq: verb not implemented yet: ${request.verb}`);
};

const toResult = (
    plan: VerbPlan,
    rendered: Rendered,
    request: QueryRequest,
    offset: number,
    freshness: WorkspaceSearchResult["freshness"],
    hint: string | undefined,
    features: ReadonlySet<Feature>,
): WorkspaceSearchResult => {
    const shownGroups: WorkspaceSearchGroup[] = plan.groups.slice(offset, offset + rendered.shownGroups).map((group) => ({
        path: group.path,
        score: group.score,
        hits: group.hits.map((hit) => ({
            line: hit.line,
            text: hit.text,
            ...(hit.start !== undefined ? { start: hit.start } : {}),
            ...(hit.end !== undefined ? { end: hit.end } : {}),
            tags: [...hit.tags],
            ...(hit.context !== undefined ? { context: hit.context } : {}),
        })),
    }));
    const total = plan.style === "paths" ? plan.groups.length : plan.groups.reduce((sum, group) => sum + group.hits.length, 0);
    const disabled = disabledOf(features);
    return {
        mode: request.verb,
        total,
        shown: rendered.shownHits,
        groups: shownGroups,
        freshness,
        truncated: rendered.truncated,
        ...(rendered.cursor !== undefined ? { cursor: rendered.cursor } : {}),
        ...(hint !== undefined ? { hint } : {}),
        ...(plan.related !== undefined && plan.related.length > 0 ? { related: plan.related } : {}),
        ...(disabled.length > 0 ? { features: disabled } : {}),
    };
};

export const dispatch = async (context: DispatchContext, request: QueryRequest, defaultEntries: readonly FileEntry[]): Promise<QueryOutcome> => {
    const scopeKey = JSON.stringify(request.scope);
    const id = cursorId(request.echo, scopeKey);

    let plan: VerbPlan | undefined;
    let offset = 0;
    let headerNote: string | undefined;
    if (request.render.after !== undefined) {
        const decoded = decodeCursor(request.render.after);
        if (decoded === undefined) {
            throw new Error(`iq: invalid cursor: ${request.render.after}`);
        }
        offset = decoded.offset;
        const spool = readSpool(context.indexDir, decoded.id);
        if (spool !== undefined && spool.generation === context.generation) {
            plan = { groups: [...spool.groups], unit: spool.unit, style: spool.style, showTags: spool.showTags };
        } else {
            headerNote = "cursor stale — re-ran";
        }
    }

    if (plan === undefined) {
        // The default sweep is reused from revalidation; --ignored needs its own wider (still floor-guarded) sweep.
        const baseEntries = request.scope.ignored === true ? await sweep(context.root, true) : defaultEntries;
        const entries = filterScope(baseEntries, request.scope);
        // --lang mismatch: a language filter that emptied an otherwise non-empty scope is almost always the wrong
        // language for this repo (e.g. `--lang ts` on a Python repo) — name the languages that ARE present rather
        // than returning a silent, indistinguishable zero.
        if (entries.length === 0 && request.scope.langs !== undefined) {
            const { langs: _langs, ...scopeSansLang } = request.scope;
            const present = [
                ...new Set(
                    filterScope(baseEntries, scopeSansLang)
                        .map((entry) => langOf(entry.path))
                        .filter((lang): lang is string => lang !== undefined),
                ),
            ];
            if (present.length > 0) {
                headerNote = `no ${request.scope.langs.join(",")} files in scope — found: ${present.slice(0, 6).join(", ")}`;
            }
        }
        plan = await runVerb(context, request, entries);
        if (context.features.has("symctx") && ["find", "q", "ask", "refs"].includes(request.verb)) {
            enrichContext(context.db, plan.groups);
        }
        // Show-don't-point applies only where the agent's next move would be a Read: natural-language answers.
        // Cursor replays skip this block — spooled groups are already packed.
        if (context.features.has("pack") && (request.verb === "ask" || (request.verb === "q" && classify(request.query) === "natural"))) {
            plan = { ...plan, groups: packGroups(context.db, plan.groups) };
        }
    }

    const disabled = disabledOf(context.features);
    const featureNote = disabled.length > 0 ? `features ${disabled.map((feature) => `-${feature}`).join(",")}` : undefined;

    const hint = plan.hint ?? (plan.groups.length === 0 ? zeroHitHint(request) : undefined);
    const note = [headerNote ?? plan.headerNote, featureNote].filter((part) => part !== undefined).join(" · ") || undefined;
    const rendered = renderText({
        verb: request.verb,
        echo: request.echo,
        unit: plan.unit,
        style: plan.style,
        showTags: plan.showTags,
        groups: plan.groups,
        offset,
        freshness: context.freshness,
        budget: request.render.budget,
        ...(request.render.limit !== undefined ? { limit: request.render.limit } : {}),
        ...(request.render.filesOnly !== undefined ? { filesOnly: request.render.filesOnly } : {}),
        ...(request.render.count !== undefined ? { count: request.render.count } : {}),
        ...(note !== undefined ? { headerNote: note } : {}),
        ...(hint !== undefined ? { hint } : {}),
        ...(plan.related !== undefined && plan.related.length > 0 ? { related: plan.related } : {}),
        ...(plan.candidates !== undefined && plan.candidates.length > 0 ? { candidates: plan.candidates } : {}),
        cursorId: id,
    });

    if (rendered.truncated) {
        writeSpool(context.indexDir, id, {
            generation: context.generation,
            createdAt: Date.now(),
            echo: request.echo,
            unit: plan.unit,
            style: plan.style,
            showTags: plan.showTags,
            groups: plan.groups,
        });
    }

    return {
        result: toResult(plan, rendered, request, offset, context.freshness, hint, context.features),
        text: rendered.text,
        exitCode: rendered.exitCode,
    };
};
