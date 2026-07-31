import { useHighlighter } from "@intentic-app/ui";

/* The comment-free view of a file that the diff surface shows by default (useLayout.showComments).
 *
 * Reviewing a change means asking what the CODE now does, and in a codebase that comments as heavily as this one
 * the prose routinely outweighs the change it explains. Comments are removed rather than folded away, so the diff
 * is COMPUTED on code alone: a comment-only edit stops being a change at all and Monaco's hideUnchangedRegions
 * swallows it. The cost is that the models no longer line up with the file, so each side reports the source line
 * every line it kept came from and the gutter renders those instead of the model's own numbering.
 *
 * The comment spans come from the same TextMate grammar Shiki already loaded to COLOR the file — every language
 * we ship highlighting for gets this for free, and there is no per-language comment table to drift. Types are
 * derived off useHighlighter rather than imported from shiki, which is a dependency of @intentic-app/ui only. */

type ShikiCore = NonNullable<Awaited<ReturnType<ReturnType<typeof useHighlighter>[`ensureLang`]>>>;
type Grammar = ReturnType<ShikiCore[`getLanguage`]>;
type Token = ReturnType<Grammar[`tokenizeLine`]>[`tokens`][number];
// The tokenizer's carry between lines — null starts a file, and a block comment's open stays on it until its close.
type RuleStack = Parameters<Grammar[`tokenizeLine`]>[1];

// One side of a diff: the text to show, and the 1-based source line each of its lines came from.
export type CodeSide = { text: string; lines: number[] };

// The guards @shikijs/monaco puts on the same grammars, for the same reason: a minified bundle opened as a diff
// must not cost the frame. Past either, the line is kept exactly as it is.
const MAX_TOKENIZED_LINE = 20_000;
const TOKENIZE_TIME_LIMIT = 500;

// A token stack is a comment when any scope in it is `comment` or below. The deepest scope of a `//` run names the
// punctuation or the content, but its parent is always `comment.line…` / `comment.block…`. Leading indentation is
// scoped `punctuation.whitespace.comment.leading…`, which deliberately does NOT match — it is whitespace either way.
const isComment = (scopes: readonly string[]): boolean => scopes.some((scope) => scope === `comment` || scope.startsWith(`comment.`));

const isBlank = (line: string): boolean => line.trim() === ``;

// The line without its trailing comment, or undefined when the comment was all it held. Only a TRAILING run is
// cut: a comment wedged between code (`f(/* n */ 1)`) stays, rather than splicing the statement around it.
const stripLine = (line: string, tokens: readonly Token[]): string | undefined => {
    let cut = -1;
    for (const token of tokens.toReversed()) {
        if (isComment(token.scopes)) {
            cut = token.startIndex;
            continue;
        }
        if (isBlank(line.slice(token.startIndex, token.endIndex))) {
            continue; // the gap between the code and the comment trailing it
        }
        break;
    }
    if (cut < 0) {
        return line; // nothing to cut — which is also how a blank line survives, since blank lines are structure
    }
    const kept = line.slice(0, cut).trimEnd();
    return kept === `` ? undefined : kept;
};

// `text` with every comment removed, or undefined when we ship no grammar for `lang` and so have nothing to go on
// (an unknown extension, plaintext) — the caller then shows the file verbatim.
export const stripComments = async (text: string, lang: string | undefined): Promise<CodeSide | undefined> => {
    if (lang === undefined) {
        return undefined;
    }
    const core = await useHighlighter().ensureLang(lang);
    if (core === undefined) {
        return undefined;
    }
    const grammar = core.getLanguage(lang);
    const kept: string[] = [];
    const lines: number[] = [];
    let stack: RuleStack = null;
    let dropped = false;
    text.split(`\n`).forEach((line, index) => {
        const result = line.length < MAX_TOKENIZED_LINE ? grammar.tokenizeLine(line, stack, TOKENIZE_TIME_LIMIT) : undefined;
        if (result !== undefined) {
            stack = result.ruleStack;
        }
        // An untokenized line has no comment we can see, so it stays whole — and `stack` stays where it was, which
        // is what keeps an open block comment open across it.
        const code = result === undefined || result.stoppedEarly ? line : stripLine(line, result.tokens);
        // A comment block almost always sits between two blank lines; removing it would leave both behind, so a
        // blank that now follows a removal and a blank collapses into the one already there.
        if (code === undefined || (dropped && isBlank(code) && isBlank(kept.at(-1) ?? ``))) {
            dropped = true;
            return;
        }
        dropped = false;
        kept.push(code);
        lines.push(index + 1);
    });
    return { text: kept.join(`\n`), lines };
};
