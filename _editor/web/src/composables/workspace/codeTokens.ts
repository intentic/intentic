import { useHighlighter } from "@intentic/ui";

/* One line-by-line walk of a file's TextMate tokens — the pass both of the diff surface's readings of a file
 * are built on: which lines are comments (codeComments) and which are imports (codeImports).
 *
 * The tokens come from the same grammar Shiki already loaded to COLOR the file, so every language we ship
 * highlighting for is covered by both readings for free and there is no per-language table to drift. Types are
 * derived off useHighlighter rather than imported from shiki, which is a dependency of @intentic/ui only. */

type ShikiCore = NonNullable<Awaited<ReturnType<ReturnType<typeof useHighlighter>[`ensureLang`]>>>;
type Grammar = ReturnType<ShikiCore[`getLanguage`]>;
type Tokenized = ReturnType<Grammar[`tokenizeLine`]>;
export type Token = Tokenized[`tokens`][number];
// The tokenizer's carry between lines — null starts a file, and a block comment's open stays on it until its close.
type RuleStack = Parameters<Grammar[`tokenizeLine`]>[1];

// The guard @shikijs/monaco puts on the same grammars, for the same reason: a minified bundle opened as a diff
// must not cost the frame. Past it, the line is handed over untokenized.
const MAX_TOKENIZED_LINE = 20_000;

// The hang guard, spent across the WHOLE file rather than per line. A per-line limit charges the first line for
// compiling the grammar's regexes — on a loaded machine that alone outruns any frame-sized budget, and the line it
// lands on is emitted verbatim, so the file comes back part-read with no sign anything went wrong. The walk is
// awaited before the diff renders rather than run inside a frame, so the budget is generous: it exists to stop a
// pathological grammar, and blowing it abandons the file (false) instead of half-doing it.
//
// Generous has to mean far more than a walk costs, because what the budget really has to clear is a COLD grammar:
// the tokenizer compiles a rule's regexes the first time a line reaches it, once per language per session. C++'s
// come to ~0.4s on an idle machine and ~10s on one oversubscribed 10× (a CI runner sharing a desktop with five
// others) — against ~4ms a line once compiled. A budget sized for the walk therefore fires on a two-line C++ file
// that happens to be the first one opened, and the reader silently loses the import skip on it.
const TIME_BUDGET = 30_000;

export const isBlank = (line: string): boolean => line.trim() === ``;

// Is any scope in a token's stack this family — the family itself, or something below it? The deepest scope of a
// `//` run names the punctuation or the content, but its parent is always `comment.line…` / `comment.block…`, and
// the same holds for the import families. Matching on the dotted prefix is also what keeps the families apart:
// `meta.include` is PHP's include statement, never SCSS's `meta.at-rule.include.scss` (a mixin call — real code).
export const scopedAs = (scopes: readonly string[], family: string): boolean =>
    scopes.some((scope) => scope === family || scope.startsWith(`${family}.`));

// The first token holding anything but whitespace — the one that says what KIND of line this is.
export const leadToken = (line: string, tokens: readonly Token[]): Token | undefined =>
    tokens.find((token) => !isBlank(line.slice(token.startIndex, token.endIndex)));

// Walk every line of `text`, handing each to `visit` with its tokens — undefined for a line past the tokenizer
// cap, which has no tokens we can see (the caller decides what an unreadable line means to it). False means the
// walk never finished — no grammar for `lang`, or the budget ran out — and a PART-read file is worse than none.
export const walkTokens = async (
    text: string,
    lang: string | undefined,
    visit: (line: string, tokens: readonly Token[] | undefined, index: number) => void,
): Promise<boolean> => {
    if (lang === undefined) {
        return false;
    }
    const core = await useHighlighter().ensureLang(lang);
    if (core === undefined) {
        return false;
    }
    const grammar = core.getLanguage(lang);
    let stack: RuleStack = null;
    const deadline = performance.now() + TIME_BUDGET;
    for (const [index, line] of text.split(`\n`).entries()) {
        const left = deadline - performance.now();
        if (left <= 0) {
            return false;
        }
        // The rest of the budget is also this line's limit, so one pathological line cannot outrun it.
        // Annotated because `stack` is written from this result a few lines down, and a loop-carried inference
        // between the two is a cycle the checker refuses.
        const result: Tokenized | undefined = line.length < MAX_TOKENIZED_LINE ? grammar.tokenizeLine(line, stack, left) : undefined;
        if (result?.stoppedEarly === true) {
            return false;
        }
        if (result !== undefined) {
            stack = result.ruleStack;
        }
        // An untokenized line leaves `stack` where it was, which is what keeps an open block comment open across it.
        visit(line, result?.tokens, index);
    }
    return true;
};
