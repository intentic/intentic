import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceSearchFreshness, WorkspaceSearchGroup, WorkspaceSearchResult } from "@intentic/sandbox-contract";
import { astSearch } from "../engines/astq.js";
import { bm25Search, prfTerms } from "../engines/bm25.js";
import { fileSearch, filesVerbHits } from "../engines/files.js";
import { changedFiles, logSearch, recentFiles, whoAnchor } from "../engines/git.js";
import { hotspotFiles } from "../engines/hotspots.js";
import { IMPACT_DEFAULTS, impactOf, testsCovering } from "../engines/impact.js";
import { buildImportGraph, fileHeads } from "../engines/import-graph.js";
import { type RgOptions, type RgResult, rgSearch } from "../engines/lexical.js";
import { repoMap } from "../engines/map.js";
import { defOf, refsOf, symSearch } from "../engines/symbols.js";
import { disabledOf, type Feature } from "../features.js";
import { classify } from "../plan/classify.js";
import type { QueryScorer } from "../query/scorer.js";
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
    // How current the index is: fresh from the CLI, or building/stale mid-revalidation from the daemon.
    readonly freshness: WorkspaceSearchFreshness;
    // Runs the semantic scan and cross-encoder rerank: the two stages heavy enough to pick their own thread.
    readonly scorer: QueryScorer;
    readonly features: ReadonlySet<Feature>;
    readonly rgPath?: string;
    // Aborts cancellable work (the rg child) if the caller's request dies mid-query.
    readonly signal?: AbortSignal;
}

interface VerbPlan {
    readonly groups: RankedGroup[];
    readonly unit: string;
    readonly style: "hits" | "paths" | "plain";
    readonly showTags: boolean;
    readonly hint?: string;
    // How the query was read when that differs from how it was written; shown in the header and to JSON callers.
    readonly headerNote?: string;
    // Which retrieval stages ran and what state the index was in; text surface only, never sent to JSON callers.
    readonly provenance?: string;
    readonly related?: string[];
    // Whether the response opens with an `answer:` anchor.
    readonly lead?: boolean;
    // True when the scan was cut short by its ceiling; reported via the same `partial` flag a per-file cap uses.
    readonly ceiling?: boolean;
    readonly confidence?: "confident" | "ambiguous";
    // Whether the top groups are delivered as code rather than as anchors (the pack stage).
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

// Groups already-ranked hits by file, preserving engine order (a group's rank is its best hit's rank); shared by fuzzy
// verbs that rank hits directly instead of fusing engines.
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

// symctx: gives every line-anchored hit its enclosing symbol so a follow-up context/Read is often unnecessary;
// def-tagged hits skip it since they already are the symbol.
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
                hit.contextLine = symbol.line;
            }
        }
    }
};

const RELATED_TOP = 3;

const isCall = (ref: EngineHit): boolean => ref.tags.some((tag) => tag.kind === "call");

// graph: resolves each top hit's strongest caller as a definition anchor instead of just suggesting `iq refs`, since
// the caller is often the other half of the answer.
// True only for a name with no whitespace: a template-heavy extractor (`.vue`, md fences) can return a multi-line
// "name" that breaks an rg pattern outright.
const isSearchableName = (name: string): boolean => name !== "" && !/\s/.test(name);

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
        if (symbol === undefined || seen.has(symbol.name) || !isSearchableName(symbol.name)) {
            continue;
        }
        seen.add(symbol.name);
        anchors.push({ name: symbol.name, path: hit.path, line: symbol.line });
    }
    // Runs one rg per symbol concurrently; order does not matter here.
    const lines = await Promise.all(
        anchors.map(async (anchor) => {
            const refs = await refsOf(db, anchor.name, undefined, rgBase).catch(() => undefined);
            // This stage is best-effort: a failed lookup drops only its own line, never the answer already computed.
            if (refs === undefined) {
                return undefined;
            }
            // Prefers a call site over a mere import, and a caller in source over one in tests, as the better answer.
            const caller =
                refs.hits.find((ref) => isCall(ref) && classOf(ref.path) === "src") ??
                refs.hits.find(isCall) ??
                refs.hits.find((ref) => classOf(ref.path) === "src") ??
                refs.hits[0];
            const from = caller !== undefined ? ` · called from ${caller.path}:${caller.line}` : "";
            const more = refs.hits.length > 1 ? ` · ${refs.hits.length - 1} more: iq refs ${anchor.name}` : "";
            return `${anchor.name}: def ${anchor.path}:${anchor.line}${from}${more}`;
        }),
    );
    return lines.filter((line) => line !== undefined);
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
// Ceiling on one packed symbol; past this the slice reads as a file, not an answer.
const PACK_MAX_LINES = 120;
// Share of the render budget packing may spend across all packed groups; the rest is for ranked candidates.
const PACK_SHARE = 0.5;
// Floor on a packed slice, so even a one-line definition ships with its surrounding neighborhood.
const PACK_MIN_LINES = 12;
// Radius around an anchor that has no enclosing symbol.
const PACK_WINDOW = 8;

// Which lines of the enclosing symbol to deliver: the whole body when it fits, otherwise the declaration plus as much
// as fits, or a window centered on the anchor once it sits beyond that.
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

// Live file text, never the indexed chunk: its stored text carries a synthetic label line that would shift anchors.
// Hits with no enclosing symbol get a window around the anchor instead.
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
            // Packs only source files; a test's anchors stay as pointers, its assertions are not worth the pack budget.
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
            // Hits outside the packed slice stay as pointers; dropping them would narrow the answer to one symbol.
            const outside = group.hits.filter((hit) => hit.line < from || hit.line > to);
            return { path: group.path, score: group.score, hits: [...packed, ...outside] };
        }),
    );
};

const ANCHOR_VERBS = new Set<Verb>(["outline", "context", "recent", "log", "who", "hotspots", "map", "impact"]);

// How many paths an `impact` header note names before it switches to counting instead.
const NOTE_PATHS = 5;

// Grep-escaped metachars rust regex takes literally: `a\|b` matches the text "a|b", not alternation.
const GREP_DIALECT = /\\[|+?(){}]/;
const GREP_DIALECT_NOTE = "pattern has grep-style escapes, iq uses rust regex: alternation is a|b (no backslash); literal text: --literal";

// Verbs that match a name or pattern literally; only the bare-query semantic pipeline reads prose intent.
const EXACT_VERBS = new Set<Verb>(["find", "files", "def", "refs", "sym", "ast"]);
// Unescaped regex metacharacters (`a|b`, `foo.*bar`, a class); the escaped case is GREP_DIALECT's.
const REGEX_INTENT = /[|()[\]*+?^$\\]/;
// A phrase, not a name: two or more whitespace-separated words. `iq find 'exact text'` also lands here, but only once
// the literal match already missed.
const isPhrase = (query: string): boolean => {
    // Trims a trailing `?`/`!`/`.` as prose punctuation, not a regex quantifier; other metacharacters still count.
    const trimmed = query.trim();
    let end = trimmed.length;
    while (end > 0) {
        const character = trimmed[end - 1];
        if (character !== "?" && character !== "!" && character !== ".") {
            break;
        }
        end -= 1;
    }
    const candidate = trimmed.slice(0, end);
    return !REGEX_INTENT.test(candidate) && candidate.split(/\s+/).length > 1;
};

// A pattern-less `iq files` truncates the whole workspace to a token budget; naming one word ranks instead of listing
// alphabetically.
const bareListingHint = (query: string, total: number): { hint?: string } =>
    query === "" ? { hint: `no pattern: this is the first page of ${total} files; name one to rank them: iq files <name>` } : {};

// Diagnoses the likely cause in priority order: grep-dialect regex, wrong verb, an over-narrow scope, then a generic
// rephrase.
const zeroHitHint = (request: QueryRequest): string | undefined => {
    if (ANCHOR_VERBS.has(request.verb)) {
        return undefined;
    }
    if (GREP_DIALECT.test(request.query)) {
        return `0 hits and the ${GREP_DIALECT_NOTE}`;
    }
    // Checked before scope: a phrase given to an exact verb matches nothing at any scope, so widening cannot help.
    if (EXACT_VERBS.has(request.verb) && isPhrase(request.query)) {
        return `0 hits, iq ${request.verb} matches ${request.verb === "files" ? "file names" : "text and names"} literally, and that query is a phrase; ask it as a question instead: iq "${request.query}"`;
    }
    const scope = request.scope;
    if (scope.langs !== undefined || scope.paths !== undefined || scope.globs !== undefined || scope.only !== undefined) {
        return "0 hits, scope may be too narrow: retry without --lang/--in/--glob/--only";
    }
    if (request.verb === "def" || request.verb === "refs") {
        return `0 hits: names are exact here; try iq sym '${request.query}*' or iq find ${request.query}`;
    }
    // A bare query at zero already passed the exact engines and the semantic pipeline; nothing else left to try.
    return "0 hits: rephrase, or search literal text with iq find 'exact text'";
};

const RERANK_TOP = 32;
// RRF constant blending the fused and cross-encoder orders; matches the k used in plan/fuse.ts.
const RERANK_RRF_K = 60;
// Below this sigmoid gap between the best and second-best file, the field counts as flat/ambiguous.
const CONFIDENCE_MARGIN = 0.05;

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

// Relative gap between the top two FILES of the order actually rendered (post-RRF blending), not raw passage scores,
// since one file scoring well twice must not read as ambiguity.
export const fieldMargin = (ordered: readonly { path: string }[], scored: readonly { hit: EngineHit; logit: number }[]): number => {
    const bestByPath = new Map<string, number>();
    for (const entry of scored) {
        const seen = bestByPath.get(entry.hit.path);
        if (seen === undefined || entry.logit > seen) {
            bestByPath.set(entry.hit.path, entry.logit);
        }
    }
    const scoreOf = (index: number): number | undefined => {
        const path = ordered[index]?.path;
        return path === undefined ? undefined : bestByPath.get(path);
    };
    const top = scoreOf(0);
    if (top === undefined) {
        return 0;
    }
    const runnerUp = scoreOf(1);
    return runnerUp === undefined ? 1 : sigmoid(top) - sigmoid(runnerUp);
};

// Cross-encoder pass over the fused top hits, blended in via RRF rather than dictating the order outright; undefined
// when this host has no cross-encoder, and the fused order then stands.
const rerankGroups = async (
    db: IndexDb,
    scorer: QueryScorer,
    query: string,
    groups: RankedGroup[],
): Promise<{ groups: RankedGroup[]; margin: number } | undefined> => {
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
    const scores = await scorer.rerank(query, passages);
    if (scores === undefined) {
        return undefined;
    }
    const scoredKeys = new Set(candidates.map((hit) => `${hit.path}:${hit.line}`));
    // Candidate index is its fused rank: candidates were taken in fused order.
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
    // Regroups by path in the new order: a group's rank is its best hit's rank.
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
    return { groups: regrouped, margin: fieldMargin(regrouped, scored) };
};

// The full natural-language pipeline: BM25 with RM3 expansion, semantic vectors, cross-encoder rerank, and code-graph
// neighbors. Reached by any query that is not a symbol, path or regex, or found nothing exactly.
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
            // RM3: the expanded query enters fusion as its own engine, so original-query ranks keep their weight.
            const expansion = prfTerms(context.db, request.query);
            if (expansion.length > 0) {
                results.push({ engine: "bm25prf", hits: bm25Search(context.db, `${request.query} ${expansion.join(" ")}`, allowed) });
            }
        }
    }
    const semantic = on("semantic") ? await context.scorer.semantic(request.query, allowed) : undefined;
    if (semantic === undefined) {
        notes.push(on("semantic") ? "no embedding backend, BM25 only" : "semantic off");
    } else {
        results.push({ engine: "semantic", hits: semantic.hits });
        if (semantic.pending > 0) {
            const total = Number(context.db.get("SELECT COUNT(*) AS n FROM chunks")?.["n"] ?? 0);
            notes.push(`embeddings ${Math.floor(((total - semantic.pending) / Math.max(1, total)) * 100)}%`);
        }
    }
    let groups = toGroups(results, request.query, entries, context.features, on("srcfirst"));
    let confidence: VerbPlan["confidence"];
    const reranked = on("rerank") && groups.length > 0 ? await rerankGroups(context.db, context.scorer, request.query, groups) : undefined;
    if (reranked !== undefined) {
        groups = reranked.groups;
        notes.push("reranked");
        // "confident" says stop reading; "ambiguous" points at the candidates rather than out to a grep spiral.
        if (on("confidence")) {
            confidence = reranked.margin < CONFIDENCE_MARGIN ? "ambiguous" : "confident";
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
    // Ceiling applies only to a list caller's first page, one past what was asked; a continuation stays contiguous.
    const ceiling =
        request.render.list !== undefined && request.render.after === undefined
            ? { maxHits: request.render.list.hits + 1, maxFiles: request.render.list.files + 1 }
            : {};
    // Passes `paths` to rg only when the scope is narrowed and under this ceiling; past it, walking the tree wins.
    const NARROWED_PATHS_MAX = 5_000;
    const narrowed =
        request.scope.globs !== undefined ||
        request.scope.notGlobs !== undefined ||
        request.scope.paths !== undefined ||
        request.scope.langs !== undefined ||
        request.scope.repo !== undefined ||
        request.scope.only !== undefined;
    const rgBase = {
        root: context.root,
        allowed,
        ...(request.scope.ignored ? { ignored: true } : {}),
        ...(context.rgPath !== undefined ? { rgPath: context.rgPath } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
        ...(narrowed && paths.length <= NARROWED_PATHS_MAX ? { paths } : {}),
    };

    if (request.verb === "find") {
        const modifiers = {
            ...(request.options.word ? { word: true } : {}),
            ...(request.options.caseSensitive ? { caseSensitive: true } : {}),
        };
        // Recovers instead of hinting: reruns literally or with escapes stripped, not a full retry turn.
        let found: RgResult;
        let note: string | undefined;
        try {
            found = await rgSearch({
                ...rgBase,
                ...ceiling,
                pattern: request.query,
                ...modifiers,
                ...(request.options.literal ? { literal: true } : {}),
            });
        } catch (error) {
            if (request.options.literal || !(error instanceof Error) || !error.message.includes("regex parse error")) {
                throw error;
            }
            found = await rgSearch({ ...rgBase, ...ceiling, pattern: request.query, ...modifiers, literal: true });
            note = "pattern isn't valid rust regex: ran as literal text (--literal)";
        }
        if (found.hits.length === 0 && note === undefined && !request.options.literal && GREP_DIALECT.test(request.query)) {
            const rewritten = request.query.replaceAll(/\\([|+?(){}])/g, "$1");
            const retried = await rgSearch({ ...rgBase, ...ceiling, pattern: rewritten, ...modifiers }).catch(() => undefined);
            if (retried !== undefined && retried.hits.length > 0) {
                found = retried;
                note = `grep-style escapes rewritten to rust regex, matched: ${rewritten}`;
            }
        }
        // Warns about grep-dialect escapes even when they matched, so a false positive doesn't teach the wrong pattern.
        if (note === undefined && !request.options.literal && GREP_DIALECT.test(request.query)) {
            note = GREP_DIALECT_NOTE;
        }
        const exactGroups = toGroups([{ engine: "lexical", hits: found.hits, capped: found.capped }], request.query, entries, context.features);
        // A prose phrase sent to `find` almost always wants the semantic pipeline; --literal is the exact-match escape.
        if (exactGroups.length === 0 && !request.options.literal && isPhrase(request.query)) {
            const escalated = await naturalPlan(context, request, entries, allowed);
            return { ...escalated, headerNote: "no exact phrase match, answered semantically" };
        }
        return {
            groups: exactGroups,
            unit: "matches",
            style: "hits",
            showTags: false,
            lead: true,
            ...(found.ceiling ? { ceiling: true } : {}),
            ...(note !== undefined ? { headerNote: note } : {}),
        };
    }

    if (request.verb === "files") {
        const hits = filesVerbHits(request.query, paths, request.options.globExact === true);
        // Preserves the engine's own ranking: each file is its own group, scored by rank.
        const groups = hits.map((hit, rank) => ({ path: hit.path, score: 1 / (rank + 1), hits: [{ ...hit, score: 1 / (rank + 1) }] }));
        return {
            groups,
            unit: "files",
            style: "paths",
            showTags: true,
            ...bareListingHint(request.query, groups.length),
        };
    }

    if (request.verb === "def") {
        const hits = defOf(context.db, request.query, allowed);
        if (hits.length > 0) {
            const groups = toGroups([{ engine: "symbols", hits }], request.query, entries, context.features);
            return { groups, unit: "definitions", style: "hits", showTags: true, lead: true, hint: `refs: iq refs ${request.query}` };
        }
        // Falls back to fuzzy symbol matches when there is no exact definition; empty here means genuinely nothing.
        const fuzzy = symSearch(context.db, request.query, undefined, allowed);
        const groups = groupByPath(fuzzy);
        return {
            groups,
            unit: "symbols",
            style: "hits",
            showTags: true,
            lead: true,
            ...(groups.length > 0 ? { headerNote: `no exact definition of "${request.query}", showing fuzzy symbol matches` } : {}),
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
            headerNote: "churn × complexity, commits over all history unless --since narrows it",
            ...(groups.length === 0 ? { hint: "no file has both commits and branch points in scope, is this a git repo with history?" } : {}),
        };
    }

    if (request.verb === "impact") {
        // Graph spans the whole corpus, never `allowed`: scoping it would silently shorten what a change reaches.
        const every = new Set(context.db.all("SELECT path FROM files").map((row) => row["path"] as string));
        const graph = buildImportGraph(context.db, every, fileHeads(context.db));
        const seeds =
            request.query === ""
                ? await changedFiles(context.root, entries)
                : request.query
                      .split(",")
                      .map((path) => path.trim())
                      .filter((path) => path !== "");
        if (seeds.length === 0) {
            return {
                groups: [],
                unit: "files",
                style: "paths",
                showTags: false,
                hint: "no uncommitted change in the sweep, name one or more paths to ask about them instead: iq impact src/app.ts",
            };
        }
        const result = impactOf(graph, seeds, IMPACT_DEFAULTS);
        const untested = seeds.filter((seed) => graph.idByPath.has(seed) && classOf(seed) !== "tests" && testsCovering(graph, seed).length === 0);
        const groups = result.reached.map((file, rank) => {
            const score = 1 / (rank + 1);
            const role = classOf(file.path) === "tests" ? "test" : "code";
            return { path: file.path, score, hits: [{ path: file.path, line: 1, text: `${file.hops} hop   ${role}`, tags: [], score }] };
        });
        // Caps how many paths are named in the note and counts the rest, so completeness reporting doesn't cost budget.
        const some = (list: readonly string[]): string =>
            list.length <= NOTE_PATHS ? list.join(", ") : `${list.slice(0, NOTE_PATHS).join(", ")} +${list.length - NOTE_PATHS} more`;
        const notes = [
            `${seeds.length} changed file${seeds.length === 1 ? "" : "s"}`,
            ...(result.truncated > 0 ? [`${result.truncated} more reachable, not shown`] : []),
            ...(result.unknownSeeds.length > 0 ? [`not indexed, no reach known: ${some(result.unknownSeeds)}`] : []),
            ...(untested.length > 0 ? [`NO TEST REACHES: ${some(untested)}`] : []),
        ];
        return {
            groups,
            unit: "files",
            style: "paths",
            showTags: false,
            headerNote: `one hop each way over the import graph, ${notes.join(" · ")}`,
            ...(groups.length === 0
                ? { hint: "nothing in the index imports these files or is imported by them, a leaf change, or the imports did not resolve" }
                : {}),
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
            ...(groups.length === 0 ? { hint: "no exported symbols in scope, widen with --in, or check the index with iq index status" } : {}),
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
            // rg keeps exhaustive precision (every occurrence exists); BM25 supplies the relevance rank.
            results.push({ engine: "lexical", ...(await rgSearch({ ...rgBase, pattern: request.query, word: true })) });
            if (on("bm25")) {
                results.push({ engine: "bm25", hits: bm25Search(context.db, request.query, allowed) });
            }
        } else {
            // Same recovery as `find`: a query that only looks like regex (`foo({`) must not crash auto mode.
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
        // Nothing matched exactly; answers semantically instead of spending a turn on a hint that says to.
        const escalated = await naturalPlan(context, request, entries, allowed);
        // Escalation reads the query itself, so it rides headerNote and reaches JSON; pipeline notes stay provenance.
        return { ...escalated, headerNote: `no exact ${kind} match, answered semantically` };
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
        // `total` is a floor if a file hit the per-file cap or the scan hit its ceiling: both mean at least this many.
        ...(plan.ceiling === true || plan.groups.some((group) => group.capped === true) ? { partial: true } : {}),
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
    // Set by a caller rendering its own rows; turns off everything that only ever fed the text capsule.
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
        // A list caller never spools: re-running from a cursor is how its Load-more works, not stale-cache recovery.
        const spool = list === undefined ? readSpool(context.indexDir, decoded.id) : undefined;
        if (spool !== undefined && spool.generation === context.generation) {
            plan = { groups: [...spool.groups], unit: spool.unit, style: spool.style, showTags: spool.showTags, lead: spool.lead };
        } else if (list === undefined) {
            headerNote = "cursor stale: re-ran";
        }
    }

    if (plan === undefined) {
        // Reuses the sweep from revalidation; `--ignored` needs its own wider, still floor-guarded sweep.
        const baseEntries = request.scope.ignored === true ? await sweep(context.root, true) : defaultEntries;
        const entries = filterScope(baseEntries, request.scope);
        // An empty scope from `--lang` alone is usually the wrong language for this repo; names the ones present.
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
                headerNote = `no ${request.scope.langs.join(",")} files in scope, found: ${present.slice(0, 6).join(", ")}`;
            }
        }
        plan = await runVerb(context, request, entries);
        // Runs before packing: pack turns anchors into plain lines, which enrichment would wrongly label as symbols.
        if (list === undefined && context.features.has("symctx") && ["find", "q", "refs"].includes(request.verb)) {
            enrichContext(context.db, plan.groups);
        }
        // Applies only to natural-language answers, where a Read would follow; list callers and cursor replays opt out.
        if (list === undefined && context.features.has("pack") && plan.pack === true) {
            plan = { ...plan, groups: await packGroups(context.db, context.root, plan.groups, request.render.budget) };
        }
    }

    const disabled = disabledOf(context.features);
    const featureNote = disabled.length > 0 ? `features ${disabled.map((feature) => `-${feature}`).join(",")}` : undefined;

    const hint = plan.hint ?? (plan.groups.length === 0 ? zeroHitHint(request) : undefined);
    // Capsule text carries everything about the run; the JSON result carries only what the caller's query provoked.
    const note = headerNote ?? plan.headerNote;
    const capsuleNote = [note, plan.provenance, featureNote].filter((part) => part !== undefined).join(" · ") || undefined;
    const rendered =
        list !== undefined
            ? renderList(plan.groups, offset, list, id, plan.ceiling === true)
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

    // A list caller re-runs instead of spooling; spooling every keystroke's groups would flood the event loop.
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
