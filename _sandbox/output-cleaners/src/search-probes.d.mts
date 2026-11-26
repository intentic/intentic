// Types for search-probes.mjs: what an empty shell search would have found with one switch changed.

export type ProbeKind = "case" | "ignored" | "literal";

export interface ProbeHit {
    readonly kind: ProbeKind;
    // Files that would match; a floor when `more`.
    readonly files: number;
    readonly more: boolean;
    readonly examples: readonly string[];
}

export type ProbeLabels = Readonly<Record<ProbeKind, string>>;

// A search command as the probes read it.
export interface ShellSearch {
    readonly program: "rg" | "grep";
    readonly pattern: string;
    readonly paths: readonly string[];
    // Its flag words that narrow what is searched, kept in every probe.
    readonly kept: readonly string[];
    readonly ignoreCase: boolean;
    readonly literal: boolean;
    readonly recursive: boolean;
    readonly hidden: boolean;
    readonly noIgnore: boolean;
}

export interface ShellProbe {
    readonly kind: ProbeKind;
    readonly before: readonly string[];
    readonly after: readonly string[];
}

export interface EmptySearchOptions {
    readonly command: string;
    readonly exitCode: string;
    // The last pipeline's statuses, space-separated (the pane's PIPESTATUS).
    readonly pipeline?: string;
    // The directory the command started in; the process's own when absent.
    readonly cwd?: string;
    readonly budgetMs?: number;
    // The filter's enabled stages; without `probes` nothing is probed.
    readonly enabled?: ReadonlySet<string>;
}

export interface Filtered {
    readonly out: string;
    readonly stages: readonly { readonly id: string; readonly saved: number }[];
}

export const PROBE_BUDGET_MS: number;
export const REGEX_SYNTAX: RegExp;
export const PROBE_PRUNE_GLOBS: readonly string[];
export const RG_LABELS: ProbeLabels;
export const hasCase: (pattern: string) => boolean;
export const probeNote: (hits: readonly ProbeHit[], labels?: ProbeLabels) => string | undefined;
export const searchCommandOf: (line: string, cwd: string) => { readonly words: string[]; readonly cwd: string; readonly piped: boolean } | undefined;
export const searchOfWords: (words: readonly string[]) => ShellSearch | undefined;
export const probesOf: (search: ShellSearch) => ShellProbe[];
export const emptySearchNote: (raw: string, options: EmptySearchOptions) => string | undefined;
export const withSearchProbes: <T extends Filtered>(raw: string, filtered: T, options: EmptySearchOptions) => Filtered;
