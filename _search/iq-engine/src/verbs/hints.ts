// The notes and hints an answer carries when it found little or nothing: why a query missed (grep dialect, a phrase
// given to an exact verb, an over-narrow scope) and what to ask instead. Pure; dispatch.ts decides when each applies.
import type { QueryRequest, Verb } from "../types.js";

const ANCHOR_VERBS = new Set<Verb>(["outline", "context", "read", "recent", "log", "who", "hotspots", "map", "impact"]);

// How many paths a note names before it switches to counting instead.
const NOTE_PATHS = 5;

// Caps how many paths are named in a note and counts the rest, so completeness reporting doesn't cost budget.
export const namedPaths = (list: readonly string[]): string =>
    list.length <= NOTE_PATHS ? list.join(", ") : `${list.slice(0, NOTE_PATHS).join(", ")} +${list.length - NOTE_PATHS} more`;

// Grep-escaped metachars rust regex takes literally: `a\|b` matches the text "a|b", not alternation.
export const GREP_DIALECT = /\\[|+?(){}]/;
export const GREP_DIALECT_NOTE = "pattern has grep-style escapes, iq uses rust regex: alternation is a|b (no backslash); literal text: --literal";

// Verbs that match a name or pattern literally; only the bare-query semantic pipeline reads prose intent.
const EXACT_VERBS = new Set<Verb>(["find", "files", "def", "refs", "sym", "ast"]);
// Unescaped regex metacharacters (`a|b`, `foo.*bar`, a class); the escaped case is GREP_DIALECT's.
const REGEX_INTENT = /[|()[\]*+?^$\\]/;
// A phrase, not a name: two or more whitespace-separated words. `iq find 'exact text'` also lands here, but only once
// the literal match already missed.
export const isPhrase = (query: string): boolean => {
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
export const bareListingHint = (query: string, total: number): { hint?: string } =>
    query === "" ? { hint: `no pattern: this is the first page of ${total} files; name one to rank them: iq files <name>` } : {};

// Diagnoses the likely cause in priority order: grep-dialect regex, wrong verb, an over-narrow scope, then a generic
// rephrase.
export const zeroHitHint = (request: QueryRequest): string | undefined => {
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
