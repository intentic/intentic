import type { WorkspaceSearchFreshness, WorkspaceSearchResult, WorkspaceSearchSpan, WorkspaceSearchTag } from "@intentic/sandbox-contract";
import type { Feature } from "./features.js";

// A bare `q` whose words are not a symbol, path or regex is the semantic pipeline; an exact query that finds nothing
// escalates into it.
export type Verb = "q" | "find" | "files" | "def" | "refs" | "sym" | "ast" | "outline" | "context" | "recent" | "log" | "who" | "hotspots" | "map" | "impact";

export type FileClass = "tests" | "src" | "docs" | "config";

// Scope narrowing shared by every verb; `ignored` lifts only the junk/.gitignore layers, never the security floor.
export interface Scope {
    readonly paths?: readonly string[];
    readonly repo?: string;
    readonly langs?: readonly string[];
    readonly globs?: readonly string[];
    readonly notGlobs?: readonly string[];
    readonly only?: FileClass;
    readonly ignored?: boolean;
}

export interface RenderOptions {
    readonly budget: number;
    readonly limit?: number;
    readonly contextLines?: number;
    readonly filesOnly?: boolean;
    readonly count?: boolean;
    readonly full?: boolean;
    readonly after?: string;
    // Set when a caller renders its own list, not the text capsule; skips pack, symctx enrichment, and the spool.
    readonly list?: ListPage;
}

// Page size for a rendered list: whole files, bounded by whichever of these two ceilings binds first.
export interface ListPage {
    readonly hits: number;
    readonly files: number;
}

// Verb-specific knobs, flattened; each verb reads only its own.
export interface VerbOptions {
    readonly literal?: boolean;
    readonly word?: boolean;
    readonly caseSensitive?: boolean;
    readonly refKind?: "call" | "import" | "type" | "write";
    readonly symKind?: "fn" | "method" | "class" | "type" | "const" | "route" | "test";
    readonly astLang?: string;
    readonly since?: string;
    readonly author?: string;
    readonly path?: string;
    readonly logRegex?: boolean;
    readonly globExact?: boolean;
    readonly mode?: Verb;
}

export interface QueryRequest {
    readonly verb: Verb;
    readonly query: string;
    readonly scope: Scope;
    readonly render: RenderOptions;
    readonly options: VerbOptions;
    // The verb and args as typed (minus output flags), echoed in the continuation footer's command.
    readonly echo: string;
    // Per-call pipeline override; absent uses the engine's own stage set, reported via features either way.
    readonly features?: ReadonlySet<Feature>;
}

export interface QueryOutcome {
    readonly result: WorkspaceSearchResult;
    readonly text: string;
    readonly exitCode: 0 | 1;
}

// One file the sweep admitted: root-relative, forward-slash path, plus the stat facts the index diffs on.
export interface FileEntry {
    readonly path: string;
    readonly abs: string;
    readonly mtimeMs: number;
    readonly size: number;
    // Root-relative path of the enclosing git repo (dir containing .git), if any.
    readonly repo?: string;
}

// A raw hit from one engine, before fusion; engines return hits in their own ranked order.
export interface EngineHit {
    readonly path: string;
    readonly line: number;
    readonly text: string;
    // Matched char spans of `text`, in order; only the lexical engine sets this, others match a whole line.
    readonly spans?: readonly WorkspaceSearchSpan[];
    readonly tags: readonly WorkspaceSearchTag[];
    // Enclosing symbol ("createWidget (fn)"), filled by the symctx enrichment stage.
    context?: string;
    // Declaration line of the enclosing symbol; the scoring line is often mid-body, so this is the reader's anchor.
    contextLine?: number;
}

export interface EngineResult {
    readonly engine: string;
    readonly hits: readonly EngineHit[];
    // Files this engine stopped reading early; only the lexical engine truncates, so these totals are a floor.
    readonly capped?: ReadonlySet<string>;
}

export interface RankedHit extends EngineHit {
    readonly score: number;
}

export interface RankedGroup {
    readonly path: string;
    readonly score: number;
    readonly hits: readonly RankedHit[];
    // True when this file had more matches than kept; any hit count or total built from it is a floor.
    readonly capped?: boolean;
}

export interface SymbolRow {
    readonly name: string;
    readonly kind: "fn" | "method" | "class" | "type" | "const" | "route" | "test";
    readonly line: number;
    readonly endLine: number;
    readonly signature: string;
    readonly exported: boolean;
    readonly heuristic: boolean;
}

export interface ChunkRow {
    readonly startLine: number;
    readonly endLine: number;
    readonly hash: string;
    readonly text: string;
}

export interface IndexStatus {
    readonly files: number;
    readonly symbols: number;
    readonly chunks: number;
    readonly embedded: number;
    readonly generation: number;
    readonly freshness: WorkspaceSearchFreshness;
}
