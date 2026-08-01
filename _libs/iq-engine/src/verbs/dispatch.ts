import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceSearchFreshness, WorkspaceSearchGroup, WorkspaceSearchResult } from "@intentic/sandbox-contract";
import type { Embedder } from "../embed/embedder.js";
import type { Reranker } from "../embed/reranker.js";
import { astSearch } from "../engines/astq.js";
import { bm25Search, prfTerms } from "../engines/bm25.js";
import { fileSearch } from "../engines/files.js";
import { logSearch, recentFiles, whoAnchor } from "../engines/git.js";
import { hotspotFiles } from "../engines/hotspots.js";
import { type RgOptions, type RgResult, rgSearch } from "../engines/lexical.js";
import { repoMap } from "../engines/map.js";
import { embedPending, semanticSearch } from "../engines/semantic.js";
import { defOf, refsOf, symSearch } from "../engines/symbols.js";
import { disabledOf, type Feature } from "../features.js";
import { classify } from "../plan/classify.js";
import { fuse, type FuseContext } from "../plan/fuse.js";
import { queryTokens } from "../plan/tokens.js";
import { estimateTokens } from "../render/budget.js";
import { cursorId, decodeCursor, readSpool, writeSpool } from "../render/cursor.js";
import { renderList } from "../render/list.js";
import { renderText, type Rendered } from "../render/text.js";
import type { IndexDb } from "../store/db.js";
import type { EngineHit, EngineResult, FileEntry, QueryOutcome, QueryRequest, RankedGroup, RankedHit, Verb } from "../types.js";
import { classOf, filterScope, langOf, sweep } from "../workspace/scan.js";
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
    // Whether `ask` may spend part of its own latency budget filling NULL embeddings. True for the one-shot CLI
    // engine, where a query is the only thing that ever runs; false for the resident engine, whose worker owns
    // every write to the index and keeps the backlog at zero without borrowing the request path to do it.
    readonly topUpEmbeddings: boolean;
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
    // How the query was READ when that differs from how it was written — a pattern rerun as literal text,
    // grep escapes rewritten, a language filter that matched nothing. Rendered above the results AND handed to
    // JSON callers, because it is about their query.
    readonly headerNote?: string;
    // Run provenance: which retrieval stages ran and what state the index was in. Text surface only — a GUI
    // that showed "reranked" beside every answer would be reporting normal operation as if it were news.
    readonly provenance?: string;
    readonly related?: string[];
    // Whether the response opens with an `answer:` anchor — see RenderRequest.lead.
    readonly lead?: boolean;
    readonly confidence?: "confident" | "ambiguous";
    // Whether the top groups should be delivered as code rather than as anchors (the `pack` stage).
    readonly pack?: boolean;
}

const toGroups = (
    results: EngineResult[],
    query: string,
    entries: readonly FileEntry[],
    features: ReadonlySet<Feature>,
    sourceFirst: boolean = false,
): RankedGroup[] => {
    const context: FuseContext = {
        queryTokens: queryTokens(query),
        mtimes: new Map(entries.map((entry) => [entry.path, entry.mtimeMs])),
        now: Date.now(),
        defBoost: features.has("defboost"),
        pathBoost: features.has("pathboost"),
        recency: features.has("recency"),
        sourceFirst,
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

const isCall = (ref: EngineHit): boolean => ref.tags.some((tag) => tag.kind === "call");

// graph: code-graph neighbors of the answer — the top hits' enclosing symbols as definition anchors, each with its
// strongest caller RESOLVED rather than suggested (GraphRAG-lite over the symbol table plus one rg per symbol).
// A bare `refs: iq refs X` spent the agent's next turn re-asking iq for something iq already knew, and the caller
// is usually the other half of the answer: the public entry point that reaches the implementation just found.
const relatedOf = async (db: IndexDb, groups: readonly RankedGroup[], rgBase: Omit<RgOptions, "pattern">): Promise<string[]> => {
    const cache = new Map<string, FileSymbolRange[]>();
    const seen = new Set<string>();
    const anchors: { name: string; path: string; line: number }[] = [];
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
        anchors.push({ name: symbol.name, path: hit.path, line: symbol.line });
    }
    // One rg per symbol, all at once: sequentially they tripled this stage's latency for no ordering reason.
    return Promise.all(
        anchors.map(async (anchor) => {
            const refs = await refsOf(db, anchor.name, undefined, rgBase);
            // A call site answers "who reaches this"; an import only says a file mentions it. Prefer a caller in
            // source: "called from its own test" is the least informative true answer available.
            const caller =
                refs.hits.find((ref) => isCall(ref) && classOf(ref.path) === "src") ??
                refs.hits.find(isCall) ??
                refs.hits.find((ref) => classOf(ref.path) === "src") ??
                refs.hits[0];
            const from = caller !== undefined ? ` · called from ${caller.path}:${caller.line}` : "";
            const more = refs.hits.length > 1 ? ` · ${refs.hits.length - 1} more: iq refs ${anchor.name}` : "";
            return `${anchor.name} — def ${anchor.path}:${anchor.line}${from}${more}`;
        }),
    );
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
// Ceiling on one packed symbol — past this the slice stops being an answer and starts being a file.
const PACK_MAX_LINES = 120;
// …and a second ceiling, in tokens, because PACK_MAX_LINES alone is budget-blind: a 107-line pager implementation
// packed at rank 1 spent a 1500-token budget by itself, so the ranked candidates underneath it never made the
// answer at all (benchmarked: it evicted the case's expected file from the result entirely). Packing may take at
// most this share of the budget across all packed groups — the rest belongs to the candidates it should not hide.
const PACK_SHARE = 0.5;
// Floor on a packed slice. A one-line const IS its whole definition, but a single line with nothing around it
// reads as less than the chunk this replaced; short symbols get their neighbourhood too.
const PACK_MIN_LINES = 12;
// Radius around an anchor with no enclosing symbol.
const PACK_WINDOW = 8;

// Which lines of the enclosing symbol to deliver. Whole body when it fits; otherwise the declaration plus as
// much as fits, unless the anchor sits beyond that, in which case the window centres on the anchor. The anchor
// is always inside the span — a packed slice that omits the matching line would be a worse answer than a
// pointer to it.
const packSpan = (symbol: FileSymbolRange, anchorLine: number): { from: number; to: number } => {
    const span = symbol.endLine - symbol.line + 1;
    if (span < PACK_MIN_LINES) {
        const pad = Math.floor((PACK_MIN_LINES - span) / 2);
        return { from: Math.max(1, symbol.line - pad), to: symbol.endLine + (PACK_MIN_LINES - span - pad) };
    }
    if (span <= PACK_MAX_LINES) {
        return { from: symbol.line, to: symbol.endLine };
    }
    if (anchorLine - symbol.line < PACK_MAX_LINES) {
        return { from: symbol.line, to: symbol.line + PACK_MAX_LINES - 1 };
    }
    const half = Math.floor(PACK_MAX_LINES / 2);
    return { from: anchorLine - half, to: Math.min(symbol.endLine, anchorLine - half + PACK_MAX_LINES - 1) };
};

// pack: the top groups arrive as the actual code, not a pointer — each group's best hit is replaced by its
// enclosing symbol's LIVE body, read from disk. Transcript analytics found a follow-up Read after 54% of answers,
// 78% of them re-opening a file iq had just named, which is exactly the read this is meant to save.
//
// Live text, never the indexed chunk: a chunk's stored text is prefixed with a synthetic `path § label` line, so
// slicing it shifted every line number by one and presented that marker as the file's first line of code — a
// packed answer whose anchors did not match the file it came from. Anchors are the one thing a search tool cannot
// get wrong. Hits with no enclosing symbol (a chunk-aligned semantic hit, an unparsed language) get a window
// around the anchor instead, which is the same answer `iq context` would give.
// Shrink a span to `ceiling` tokens, keeping the anchor line inside: prefer to drop the tail (a symbol reads from
// its declaration down), and only slide the window forward when the anchor itself sits past what fits.
const fitSpan = (lines: readonly string[], from: number, to: number, anchorLine: number, ceiling: number): { from: number; to: number } => {
    const spend = (start: number, limit: number): number => {
        let used = 0;
        let end = start - 1;
        for (let line = start; line <= limit; line++) {
            used += estimateTokens(lines[line - 1] ?? "");
            if (used > ceiling && line > start) {
                break;
            }
            end = line;
        }
        return end;
    };
    const end = spend(from, to);
    if (end >= anchorLine) {
        return { from, to: end };
    }
    const slid = Math.max(from, anchorLine - 2);
    return { from: slid, to: spend(slid, to) };
};

const packGroups = async (db: IndexDb, root: string, groups: readonly RankedGroup[], budget: number): Promise<RankedGroup[]> => {
    const cache = new Map<string, FileSymbolRange[]>();
    const ceiling = Math.floor((budget * PACK_SHARE) / PACK_TOP);
    return Promise.all(
        groups.map(async (group, index): Promise<RankedGroup> => {
            // Only implementation is worth a body. A test that places in the top two still spends the pack budget
            // on 40 lines of assertions nobody asked to read, and that budget is what shows the ranked files under
            // it — benchmarked: a packed test at rank 2 pushed the query's own answer out of the shown set.
            // Its anchors stay, which for a test is the useful part: where the thing under test is exercised.
            if (index >= PACK_TOP || classOf(group.path) !== "src") {
                return group;
            }
            const anchor = [...group.hits].toSorted((a, b) => b.score - a.score)[0];
            if (anchor === undefined) {
                return group;
            }
            const content = await readFile(join(root, group.path), "utf8").catch(() => undefined);
            if (content === undefined) {
                return group;
            }
            const lines = content.split(/\r?\n/);
            const symbol = enclosingSymbol(db, cache, group.path, anchor.line);
            const wanted =
                symbol !== undefined
                    ? packSpan(symbol, anchor.line)
                    : { from: Math.max(1, anchor.line - PACK_WINDOW), to: anchor.line + PACK_WINDOW };
            const { from, to } = fitSpan(lines, Math.max(1, wanted.from), Math.min(wanted.to, lines.length), anchor.line, ceiling);
            const packed = lines.slice(from - 1, to).map((text, offset): RankedHit => {
                const line = from + offset;
                return line === anchor.line ? Object.assign({}, anchor, { text }) : { path: group.path, line, text, tags: [], score: 0 };
            });
            // Anchors outside the slice stay as pointers: packing shows ONE symbol, and dropping the file's other
            // matches would silently narrow the answer to it.
            const outside = group.hits.filter((hit) => hit.line < from || hit.line > to);
            return { path: group.path, score: group.score, hits: [...packed, ...outside] };
        }),
    );
};

const ANCHOR_VERBS = new Set<Verb>(["outline", "context", "recent", "log", "who", "hotspots", "map"]);

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
    // A bare query that reaches zero has already been through both the exact engines and the semantic pipeline
    // (see the escalation in `q`), so there is no other iq verb left to suggest — only different words.
    return "0 hits — rephrase, or search literal text with iq find 'exact text'";
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

// The full natural-language pipeline: BM25 with RM3 expansion, semantic vectors, a cross-encoder rerank, and
// code-graph neighbours. Every query whose words are not already a symbol, a path or a regex arrives here, and so
// does an exact query that found nothing — which is why there is no separate verb for it. Traces recorded one
// `ask` in 245 calls against ~90 bare natural-language queries: the split was never learned, it only decided
// which callers got a reranked answer and which got raw BM25.
const naturalPlan = async (
    context: DispatchContext,
    request: QueryRequest,
    entries: readonly FileEntry[],
    allowed: ReadonlySet<string>,
): Promise<VerbPlan> => {
    const on = (feature: Feature): boolean => context.features.has(feature);
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
        const remaining = context.topUpEmbeddings
            ? await embedPending(context.db, embedder)
            : Number(context.db.get("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL")?.["n"] ?? 0);
        results.push({ engine: "semantic", hits: semanticSearch(context.db, await embedder.embedQuery(request.query), allowed) });
        if (remaining > 0) {
            const total = Number(context.db.get("SELECT COUNT(*) AS n FROM chunks")?.["n"] ?? 0);
            notes.push(`embeddings ${Math.floor(((total - remaining) / Math.max(1, total)) * 100)}%`);
        }
    }
    let groups = toGroups(results, request.query, entries, context.features, on("srcfirst"));
    let confidence: VerbPlan["confidence"];
    const reranker = on("rerank") ? await context.getReranker() : undefined;
    if (reranker !== undefined && groups.length > 0) {
        const { groups: rerankedGroups, margin } = await rerankGroups(context.db, reranker, request.query, groups);
        groups = rerankedGroups;
        notes.push("reranked");
        // A flat field means no clear winner. Say which of the two it is on the answer line: "confident" is
        // permission to stop reading, "ambiguous" points at the candidates — never out of iq into a grep spiral
        // (benchmarked: the old "try iq find" note made models abandon a correct rank-1 hit).
        if (on("confidence")) {
            confidence = margin < CONFIDENCE_MARGIN ? "ambiguous" : "confident";
        }
    }
    const rgBase = {
        root: context.root,
        allowed,
        ...(request.scope.ignored ? { ignored: true } : {}),
        ...(context.rgPath !== undefined ? { rgPath: context.rgPath } : {}),
    };
    const related = on("graph") ? await relatedOf(context.db, groups, rgBase) : [];
    return {
        groups,
        unit: "hits",
        style: "hits",
        showTags: true,
        lead: true,
        pack: true,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(notes.length > 0 ? { provenance: notes.join(" · ") } : {}),
        ...(related.length > 0 ? { related } : {}),
    };
};

const runVerb = async (context: DispatchContext, request: QueryRequest, entries: readonly FileEntry[]): Promise<VerbPlan> => {
    const on = (feature: Feature): boolean => context.features.has(feature);
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
        const modifiers = {
            ...(request.options.word ? { word: true } : {}),
            ...(request.options.caseSensitive ? { caseSensitive: true } : {}),
        };
        // Recover instead of hinting — a hint costs the agent a whole retry turn, a rerun costs milliseconds.
        // A pattern rust regex rejects (`foo({`) reruns literally; grep-style escapes (`a\|b`) that matched
        // nothing rerun with the escapes stripped. The note names what ran so the next call is canonical.
        let found: RgResult;
        let note: string | undefined;
        try {
            found = await rgSearch({ ...rgBase, pattern: request.query, ...modifiers, ...(request.options.literal ? { literal: true } : {}) });
        } catch (error) {
            if (request.options.literal || !(error instanceof Error) || !error.message.includes("regex parse error")) {
                throw error;
            }
            found = await rgSearch({ ...rgBase, pattern: request.query, ...modifiers, literal: true });
            note = "pattern isn't valid rust regex — ran as literal text (--literal)";
        }
        if (found.hits.length === 0 && note === undefined && !request.options.literal && GREP_DIALECT.test(request.query)) {
            const rewritten = request.query.replaceAll(/\\([|+?(){}])/g, "$1");
            const retried = await rgSearch({ ...rgBase, pattern: rewritten, ...modifiers }).catch(() => undefined);
            if (retried !== undefined && retried.hits.length > 0) {
                found = retried;
                note = `grep-style escapes rewritten to rust regex — matched: ${rewritten}`;
            }
        }
        // Warn about grep-dialect escapes up front — even when they accidentally matched something — so the agent
        // doesn't have to hit zero results to learn the pattern was wrong.
        if (note === undefined && !request.options.literal && GREP_DIALECT.test(request.query)) {
            note = GREP_DIALECT_NOTE;
        }
        return {
            groups: toGroups([{ engine: "lexical", hits: found.hits, capped: found.capped }], request.query, entries, context.features),
            unit: "matches",
            style: "hits",
            showTags: false,
            lead: true,
            ...(note !== undefined ? { headerNote: note } : {}),
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
            const groups = toGroups([{ engine: "symbols", hits }], request.query, entries, context.features);
            return { groups, unit: "definitions", style: "hits", showTags: true, lead: true, hint: `refs: iq refs ${request.query}` };
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
            lead: true,
            ...(groups.length > 0 ? { headerNote: `no exact definition of "${request.query}" — showing fuzzy symbol matches` } : {}),
        };
    }

    if (request.verb === "sym") {
        const hits = symSearch(context.db, request.query, request.options.symKind, allowed);
        return { groups: groupByPath(hits), unit: "symbols", style: "hits", showTags: true, lead: true };
    }

    if (request.verb === "refs") {
        const { hits, hint } = await refsOf(context.db, request.query, request.options.refKind, rgBase);
        return {
            groups: toGroups([{ engine: "refs", hits }], request.query, entries, context.features),
            unit: "refs",
            style: "hits",
            showTags: true,
            lead: true,
            ...(hint !== undefined ? { hint } : {}),
        };
    }

    if (request.verb === "ast") {
        if (request.options.astLang === undefined) {
            throw new Error("iq ast: --lang is required (the pattern's parse language)");
        }
        const hits = await astSearch(request.query, request.options.astLang, entries);
        return {
            groups: toGroups([{ engine: "ast", hits }], request.query, entries, context.features),
            unit: "matches",
            style: "hits",
            showTags: false,
            lead: true,
        };
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

    if (request.verb === "hotspots") {
        const groups = await hotspotFiles(context.db, context.root, entries, {
            ...(request.options.since !== undefined ? { since: request.options.since } : {}),
            ...(request.options.author !== undefined ? { author: request.options.author } : {}),
            ...(request.query !== "" ? { pattern: request.query } : {}),
        });
        return {
            groups,
            unit: "files",
            style: "paths",
            showTags: false,
            headerNote: "churn × complexity — commits over all history unless --since narrows it",
            ...(groups.length === 0 ? { hint: "no file has both commits and branch points in scope — is this a git repo with history?" } : {}),
        };
    }

    if (request.verb === "map") {
        const groups = repoMap(context.db, allowed);
        return {
            groups,
            unit: "symbols",
            style: "hits",
            showTags: false,
            headerNote: "files by PageRank over the import graph, exported symbols each",
            ...(groups.length === 0 ? { hint: "no exported symbols in scope — widen with --in, or check the index with iq index status" } : {}),
        };
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

    if (request.verb === "q") {
        const kind = classify(request.query);
        if (kind === "natural") {
            return naturalPlan(context, request, entries, allowed);
        }
        const results: EngineResult[] = [];
        if (kind === "path") {
            results.push({ engine: "files", hits: fileSearch(request.query, paths, /[*?[]/.test(request.query)) });
            results.push({ engine: "lexical", ...(await rgSearch({ ...rgBase, pattern: request.query, literal: true })) });
        } else if (kind === "identifier") {
            results.push({ engine: "symbols", hits: defOf(context.db, request.query, allowed) });
            // rg keeps exhaustive precision (existence of every occurrence); BM25 supplies the relevance rank.
            results.push({ engine: "lexical", ...(await rgSearch({ ...rgBase, pattern: request.query, word: true })) });
            if (on("bm25")) {
                results.push({ engine: "bm25", hits: bm25Search(context.db, request.query, allowed) });
            }
        } else {
            // Same recovery as `find`: a query that only LOOKS like regex (`foo({`) must not crash auto mode.
            const found = await rgSearch({ ...rgBase, pattern: request.query }).catch(async (error: Error) => {
                if (!error.message.includes("regex parse error")) {
                    throw error;
                }
                return rgSearch({ ...rgBase, pattern: request.query, literal: true });
            });
            results.push({ engine: "lexical", ...found });
        }
        const groups = toGroups(results, request.query, entries, context.features);
        if (groups.length > 0) {
            return { groups, unit: "hits", style: "hits", showTags: true, lead: true };
        }
        // Nothing matched that name, path or pattern exactly. A zero here was the most expensive outcome in the
        // traces — one wasted turn per occurrence — and the words are usually a concept rather than an identifier.
        // Answer it semantically instead of spending the agent's next turn on a hint telling it to.
        const escalated = await naturalPlan(context, request, entries, allowed);
        // The escalation is a reading of the QUERY, so it rides headerNote and reaches JSON callers; the
        // semantic pipeline's own notes stay provenance and print only in the capsule.
        return { ...escalated, headerNote: `no exact ${kind} match — answered semantically` };
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
    note: string | undefined,
    features: ReadonlySet<Feature>,
): WorkspaceSearchResult => {
    const shownGroups: WorkspaceSearchGroup[] = plan.groups.slice(offset, offset + rendered.shownGroups).map((group) =>
        Object.assign(
            {
                path: group.path,
                score: group.score,
                hits: group.hits.map((hit) => ({
                    line: hit.line,
                    text: hit.text,
                    spans: hit.spans === undefined ? [] : [...hit.spans],
                    tags: [...hit.tags],
                    ...(hit.context !== undefined ? { context: hit.context } : {}),
                })),
            },
            group.capped === true ? { capped: true } : {},
        ),
    );
    const total = plan.style === "paths" ? plan.groups.length : plan.groups.reduce((sum, group) => sum + group.hits.length, 0);
    const disabled = disabledOf(features);
    return {
        mode: request.verb,
        total,
        files: plan.groups.length,
        shown: rendered.shownHits,
        groups: shownGroups,
        freshness,
        truncated: rendered.truncated,
        // `total` is a floor whenever any file's matches ran past the per-file cap — over the WHOLE match set,
        // not just this page, since that is what the number counts.
        ...(plan.groups.some((group) => group.capped === true) ? { partial: true } : {}),
        ...(rendered.cursor !== undefined ? { cursor: rendered.cursor } : {}),
        ...(hint !== undefined ? { hint } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(plan.related !== undefined && plan.related.length > 0 ? { related: plan.related } : {}),
        ...(rendered.candidates !== undefined ? { candidates: [...rendered.candidates] } : {}),
        ...(disabled.length > 0 ? { features: disabled } : {}),
    };
};

export const dispatch = async (context: DispatchContext, request: QueryRequest, defaultEntries: readonly FileEntry[]): Promise<QueryOutcome> => {
    const scopeKey = JSON.stringify(request.scope);
    const id = cursorId(request.echo, scopeKey);
    // Set by a caller that renders its own rows. It decides the page, and it turns off everything that only ever
    // fed the text capsule — see RenderOptions.list.
    const list = request.render.list;

    let plan: VerbPlan | undefined;
    let offset = 0;
    let headerNote: string | undefined;
    if (request.render.after !== undefined) {
        const decoded = decodeCursor(request.render.after);
        if (decoded === undefined) {
            throw new Error(`iq: invalid cursor: ${request.render.after}`);
        }
        offset = decoded.offset;
        // A list caller never spooled, so there is nothing to replay and nothing has gone wrong — re-running IS
        // how its cursor works, and saying "stale" would put a warning on a working Load-more.
        const spool = list === undefined ? readSpool(context.indexDir, decoded.id) : undefined;
        if (spool !== undefined && spool.generation === context.generation) {
            plan = { groups: [...spool.groups], unit: spool.unit, style: spool.style, showTags: spool.showTags, lead: spool.lead };
        } else if (list === undefined) {
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
        // Before packing, never after: pack copies the anchor hit into a run of plain lines, and enriching those
        // would label every line of a body with the symbol that body already is. A list caller renders neither —
        // this was a symbol-table lookup per hit across EVERY matched file, on every keystroke, discarded.
        if (list === undefined && context.features.has("symctx") && ["find", "q", "refs"].includes(request.verb)) {
            enrichContext(context.db, plan.groups);
        }
        // Show-don't-point applies only where the agent's next move would be a Read: natural-language answers,
        // including an exact query that escalated into one. Cursor replays skip this — spooled groups are packed.
        // A list caller opts out: a packed body's plain lines would show up there as hits of a query that never
        // matched them.
        if (list === undefined && context.features.has("pack") && plan.pack === true) {
            plan = { ...plan, groups: await packGroups(context.db, context.root, plan.groups, request.render.budget) };
        }
    }

    const disabled = disabledOf(context.features);
    const featureNote = disabled.length > 0 ? `features ${disabled.map((feature) => `-${feature}`).join(",")}` : undefined;

    const hint = plan.hint ?? (plan.groups.length === 0 ? zeroHitHint(request) : undefined);
    // Two audiences: the capsule prints everything it knows about the run, the JSON result carries only what
    // the CALLER's query provoked.
    const note = headerNote ?? plan.headerNote;
    const capsuleNote = [note, plan.provenance, featureNote].filter((part) => part !== undefined).join(" · ") || undefined;
    const rendered =
        list !== undefined
            ? renderList(plan.groups, offset, list, id)
            : renderText({
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
                  ...(capsuleNote !== undefined ? { headerNote: capsuleNote } : {}),
                  ...(hint !== undefined ? { hint } : {}),
                  ...(plan.related !== undefined && plan.related.length > 0 ? { related: plan.related } : {}),
                  ...(plan.lead === true ? { lead: true } : {}),
                  ...(plan.confidence !== undefined ? { confidence: plan.confidence } : {}),
                  cursorId: id,
              });

    // A list caller's continuation re-runs instead — spooling every group of a keystroke-driven search would put
    // a megabyte of synchronous JSON on the daemon's event loop per typed character.
    if (rendered.truncated && list === undefined) {
        writeSpool(context.indexDir, id, {
            generation: context.generation,
            createdAt: Date.now(),
            echo: request.echo,
            unit: plan.unit,
            style: plan.style,
            showTags: plan.showTags,
            lead: plan.lead === true,
            groups: plan.groups,
        });
    }

    return {
        result: toResult(plan, rendered, request, offset, context.freshness, hint, note, context.features),
        text: rendered.text,
        exitCode: rendered.exitCode,
    };
};
