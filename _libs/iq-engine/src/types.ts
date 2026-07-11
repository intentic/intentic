import type { IqFreshness, IqResult, IqTag } from "@intentic/sandbox-contract";

export type Verb = "q" | "find" | "files" | "def" | "refs" | "sym" | "ast" | "ask" | "outline" | "context" | "recent" | "log" | "who";

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
    readonly result: IqResult;
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
    readonly start?: number;
    readonly end?: number;
    readonly tags: readonly IqTag[];
    // Enclosing symbol ("createWidget (fn)") — filled by the symctx enrichment stage.
    context?: string;
}

export interface EngineResult {
    readonly engine: string;
    readonly hits: readonly EngineHit[];
}

export interface RankedHit extends EngineHit {
    readonly score: number;
}

export interface RankedGroup {
    readonly path: string;
    readonly score: number;
    readonly hits: readonly RankedHit[];
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
    readonly freshness: IqFreshness;
}
