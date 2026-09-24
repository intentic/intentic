import type { HighlighterCore } from "shiki/core";

// One token walk both readings of a file share (comment/import detection); the grammar loader is the caller's, so the
// browser reuses Shiki's loaded core and the daemon builds its own.

export type Grammar = ReturnType<HighlighterCore[`getLanguage`]>;
type Tokenized = ReturnType<Grammar[`tokenizeLine`]>;
export type Token = Tokenized[`tokens`][number];
// Tokenizer state carried between lines; null starts a file, an open block comment persists until its close.
export type RuleStack = Parameters<Grammar[`tokenizeLine`]>[1];

/** Compiled grammar for a language, or undefined if this build ships none. */
export type Grammars = (lang: string) => Promise<Grammar | undefined>;

// Same line-length guard @shikijs/monaco uses; past it the line is handed over untokenized.
const MAX_TOKENIZED_LINE = 20_000;

// Spent across the whole file, not per line, so a cold grammar's regex compile doesn't starve a single line.
const TIME_BUDGET = 30_000;

export const isBlank = (line: string): boolean => line.trim() === ``;

// True if a scope in the stack equals this family or is a dotted child of it; prefix matching keeps
// identically-prefixed families in different grammars apart.
export const scopedAs = (scopes: readonly string[], family: string): boolean =>
    scopes.some((scope) => scope === family || scope.startsWith(`${family}.`));

// First token holding non-whitespace content; the one that determines what kind of line this is.
export const leadToken = (line: string, tokens: readonly Token[]): Token | undefined =>
    tokens.find((token) => !isBlank(line.slice(token.startIndex, token.endIndex)));

// One file's walk: its grammar, and the moment its budget runs out, shared by every stretch of it walked.
export interface TokenWalk {
    readonly grammar: Grammar;
    readonly deadline: number;
}

export const tokenWalk = (grammar: Grammar): TokenWalk => ({ grammar, deadline: performance.now() + TIME_BUDGET });

// Two points of a walk from which the same lines tokenize the same way.
export const sameStack = (a: RuleStack, b: RuleStack): boolean => a === b || (a !== null && b !== null && a.equals(b));

// Walks `lines` from `stack`, calling `visit` with each line's tokens (undefined past the tokenizer cap) and its index
// counted from `first`. Answers the stack after the last line, or undefined if the budget ran out.
export const walkLines = (
    walk: TokenWalk,
    lines: readonly string[],
    stack: RuleStack,
    visit: (line: string, tokens: readonly Token[] | undefined, index: number) => boolean | void,
    first = 0,
): { readonly stack: RuleStack } | undefined => {
    let current = stack;
    for (const [offset, line] of lines.entries()) {
        const left = walk.deadline - performance.now();
        if (left <= 0) {
            return undefined;
        }
        // Remaining budget also caps this line; type annotation breaks an inference cycle with `current` below.
        const result: Tokenized | undefined = line.length < MAX_TOKENIZED_LINE ? walk.grammar.tokenizeLine(line, current, left) : undefined;
        if (result?.stoppedEarly === true) {
            return undefined;
        }
        if (result !== undefined) {
            current = result.ruleStack;
        }
        // Skipping stack update on an untokenized line keeps an open block comment open across it. A visit answering
        // true ends the walk there, which is still a finished walk.
        if (visit(line, result?.tokens, first + offset) === true) {
            break;
        }
    }
    return { stack: current };
};

// Walks every line of `text`, calling `visit` with its tokens (undefined past the tokenizer cap). Returns false if the
// walk didn't finish (no grammar for `lang`, or the budget ran out).
export const walkTokens = async (
    text: string,
    lang: string | undefined,
    grammars: Grammars,
    visit: (line: string, tokens: readonly Token[] | undefined, index: number) => void,
): Promise<boolean> => {
    if (lang === undefined) {
        return false;
    }
    const grammar = await grammars(lang);
    if (grammar === undefined) {
        return false;
    }
    return walkLines(tokenWalk(grammar), text.split(`\n`), null, visit) !== undefined;
};
