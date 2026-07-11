import { buildChoiceParser, numberParser } from "@stricli/core";
import { canonicalLang, type RenderOptions, type Scope, type Verb, type VerbOptions } from "@intentic/iq-engine";

// Unknown lang tokens are usage errors, never silent empty filters (exts and canonical names both accepted).
export const parseLangs = (value: string): string[] => {
    const tokens = value.split(",").map((token) => token.trim());
    for (const token of tokens) {
        if (canonicalLang(token) === undefined) {
            throw new Error(`unknown --lang "${token}" — known: ts, tsx, js, py, go, rs, java (extensions or names)`);
        }
    }
    return tokens;
};

export interface ScopeFlags {
    readonly in?: readonly string[];
    readonly repo?: string;
    readonly lang?: readonly string[];
    readonly glob?: readonly string[];
    readonly notGlob?: readonly string[];
    readonly only?: "tests" | "src" | "docs" | "config";
    readonly ignored: boolean;
}

export interface OutputFlags {
    readonly budget: number;
    readonly limit?: number;
    readonly contextLines?: number;
    readonly filesOnly: boolean;
    readonly count: boolean;
    readonly full: boolean;
    readonly json: boolean;
    readonly ndjson: boolean;
    readonly after?: string;
    readonly features?: string;
}

export type SearchFlags = ScopeFlags & OutputFlags;

// Shared parameter fragments — spread into each command's `parameters.flags` so every verb narrows and renders
// identically. The kebab scanner maps --not-glob → notGlob, --files-only → filesOnly, --context-lines (-C).
export const scopeFlagParameters = {
    in: { kind: "parsed", parse: String, variadic: true, optional: true, brief: "Restrict to subtree(s); repeatable" },
    repo: { kind: "parsed", parse: String, optional: true, brief: "Restrict to one repo of the workspace" },
    lang: { kind: "parsed", parse: parseLangs, optional: true, brief: "Language filter, comma-separated (ts,py,go,…)" },
    glob: { kind: "parsed", parse: String, variadic: true, optional: true, brief: "Include path glob; repeatable" },
    notGlob: { kind: "parsed", parse: String, variadic: true, optional: true, brief: "Exclude path glob; repeatable" },
    only: { kind: "parsed", parse: buildChoiceParser(["tests", "src", "docs", "config"]), optional: true, brief: "File-class shortcut" },
    ignored: { kind: "boolean", default: false, brief: "Include .gitignore'd files (secrets floor never lifts)" },
} as const;

export const outputFlagParameters = {
    budget: { kind: "parsed", parse: numberParser, default: "1500", brief: "Max output tokens; the tool allocates them" },
    limit: { kind: "parsed", parse: numberParser, optional: true, brief: "Cap result groups (files)" },
    contextLines: { kind: "parsed", parse: numberParser, optional: true, brief: "Context lines around matches" },
    filesOnly: { kind: "boolean", default: false, brief: "Ranked paths + match counts only" },
    count: { kind: "boolean", default: false, brief: "Counts only" },
    full: { kind: "boolean", default: false, brief: "Disable snippet elision (budget still applies)" },
    json: { kind: "boolean", default: false, brief: "One JSON result document" },
    ndjson: { kind: "boolean", default: false, brief: "One JSON line per result group" },
    after: { kind: "parsed", parse: String, optional: true, brief: "Resume a truncated result at its cursor" },
    features: { kind: "parsed", parse: String, optional: true, brief: "Retrieval-stage toggles (bm25 = only; -rerank,-prf = all except)" },
} as const;

export const outputAliases = { C: "contextLines" } as const;

export const toScope = (flags: ScopeFlags): Scope => ({
    ...(flags.in !== undefined ? { paths: flags.in } : {}),
    ...(flags.repo !== undefined ? { repo: flags.repo } : {}),
    ...(flags.lang !== undefined ? { langs: flags.lang } : {}),
    ...(flags.glob !== undefined ? { globs: flags.glob } : {}),
    ...(flags.notGlob !== undefined ? { notGlobs: flags.notGlob } : {}),
    ...(flags.only !== undefined ? { only: flags.only } : {}),
    ...(flags.ignored ? { ignored: true } : {}),
});

export const toRender = (flags: OutputFlags): RenderOptions => ({
    budget: flags.budget,
    ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
    ...(flags.contextLines !== undefined ? { contextLines: flags.contextLines } : {}),
    ...(flags.filesOnly ? { filesOnly: true } : {}),
    ...(flags.count ? { count: true } : {}),
    ...(flags.full ? { full: true } : {}),
    ...(flags.after !== undefined ? { after: flags.after } : {}),
});

const quote = (value: string): string => (/^[\w./:@*?[\]-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`);

// The verb + args echoed into truncation footers as the literal continuation command. Scope + verb flags only —
// output flags (budget/after/json) are the caller's per-invocation choice.
export const echoOf = (verb: Verb, query: string, flags: ScopeFlags, options: VerbOptions): string => {
    const parts = [verb === "q" ? quote(query) : `${verb} ${quote(query)}`];
    for (const path of flags.in ?? []) {
        parts.push(`--in ${quote(path)}`);
    }
    if (flags.repo !== undefined) {
        parts.push(`--repo ${quote(flags.repo)}`);
    }
    if (flags.lang !== undefined) {
        parts.push(`--lang ${flags.lang.join(",")}`);
    }
    for (const glob of flags.glob ?? []) {
        parts.push(`--glob ${quote(glob)}`);
    }
    for (const glob of flags.notGlob ?? []) {
        parts.push(`--not-glob ${quote(glob)}`);
    }
    if (flags.only !== undefined) {
        parts.push(`--only ${flags.only}`);
    }
    if (flags.ignored) {
        parts.push("--ignored");
    }
    if (options.literal) {
        parts.push("--literal");
    }
    if (options.word) {
        parts.push("--word");
    }
    if (options.caseSensitive) {
        parts.push("--case");
    }
    if (options.refKind !== undefined || options.symKind !== undefined) {
        parts.push(`--kind ${options.refKind ?? options.symKind}`);
    }
    if (options.globExact) {
        parts.push("--exact");
    }
    if (options.since !== undefined) {
        parts.push(`--since ${quote(options.since)}`);
    }
    if (options.author !== undefined) {
        parts.push(`--author ${quote(options.author)}`);
    }
    if (options.path !== undefined) {
        parts.push(`--path ${quote(options.path)}`);
    }
    if (options.mode !== undefined) {
        parts.push(`--mode ${options.mode}`);
    }
    return parts.join(" ");
};
