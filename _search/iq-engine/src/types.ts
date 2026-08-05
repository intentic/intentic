import type { WorkspaceSearchFreshness, WorkspaceSearchResult, WorkspaceSearchSpan, WorkspaceSearchTag } from "@intentic/sandbox-contract";

// No separate natural-language verb: a bare `q` whose words are not a symbol, path or regex IS the semantic
// pipeline, and an exact query that finds nothing escalates into it.
export type Verb = "q" | "find" | "files" | "def" | "refs" | "sym" | "ast" | "outline" | "context" | "recent" | "log" | "who" | "hotspots" | "map";

export type FileClass = "tests" | "src" | "docs" | "config";

// Scope narrowing shared by every verb. `ignored` lifts the junk/.gitignore layers only — never the security floor.
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
    /* Set by a caller that renders its OWN result list (the workspace panel) instead of the text capsule, and
     * sizes the page for it: rows, not tokens. Everything the capsule needs is then skipped, because all of it
     * was being built and thrown away — the text itself, the `pack` stage (whose non-matching body lines would
     * be listed as if they were hits), the symbol-context enrichment (a list shows the line, not its enclosing
     * symbol), and the continuation spool (megabytes of groups written to disk on every keystroke). A `--after`
     * page re-runs the search instead of replaying that spool; for a list caller the search is the cheap part. */
    readonly list?: ListPage;
}

// The page a rendered list wants: whole files, up to these two ceilings, whichever binds first.
export interface ListPage {
    readonly hits: number;
    readonly files: number;
}

// Verb-specific knobs, flattened — each verb reads only its own.
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
    // The verb + args as the user typed them (minus output flags) — echoed in the truncation footer's
    // continuation command.
    readonly echo: string;
}

export interface QueryOutcome {
    readonly result: WorkspaceSearchResult;
    readonly text: string;
    readonly exitCode: 0 | 1;
}

// One file the sweep admitted: root-relative forward-slash path plus the stat facts the index diffs on.
export interface FileEntry {
    readonly path: string;
    readonly abs: string;
    readonly mtimeMs: number;
    readonly size: number;
    // Root-relative path of the enclosing git repo (dir containing .git), if any.
    readonly repo?: string;
}

// A raw hit as produced by one engine, before fusion. Engines return hits in their own ranked order.
export interface EngineHit {
    readonly path: string;
    readonly line: number;
    readonly text: string;
    // Char spans of `text` that matched, in order. Absent for every engine that matches a LINE rather than a
    // span of one (bm25, semantic, symbols, git) — only the lexical engine can say where in the line it hit.
    readonly spans?: readonly WorkspaceSearchSpan[];
    readonly tags: readonly WorkspaceSearchTag[];
    // Enclosing symbol ("createWidget (fn)") — filled by the symctx enrichment stage.
    context?: string;
}

export interface EngineResult {
    readonly engine: string;
    readonly hits: readonly EngineHit[];
    // Files this engine stopped reading before it ran out of matches. Only the lexical engine truncates (it caps
    // what one file may contribute); the group it lands in says so, so a total over these hits is a floor.
    readonly capped?: ReadonlySet<string>;
}

export interface RankedHit extends EngineHit {
    readonly score: number;
}

export interface RankedGroup {
    readonly path: string;
    readonly score: number;
    readonly hits: readonly RankedHit[];
    // This file had more matches than the engine kept — its hit count, and any total built from it, is a floor.
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
