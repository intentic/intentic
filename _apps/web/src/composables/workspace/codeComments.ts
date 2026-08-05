import { isBlank, scopedAs, type Token, walkTokens } from "./codeTokens";

/* The comment-free view of a file that the diff surface shows by default (useLayout.showComments).
 *
 * Reviewing a change means asking what the CODE now does, and in a codebase that comments as heavily as this one
 * the prose routinely outweighs the change it explains. Comments are removed rather than folded away, so the diff
 * is COMPUTED on code alone: a comment-only edit stops being a change at all and Monaco's hideUnchangedRegions
 * swallows it. The cost is that the models no longer line up with the file, so each side reports the source line
 * every line it kept came from and the gutter renders those instead of the model's own numbering.
 *
 * The comment spans come from the TextMate grammar Shiki already loaded to COLOR the file — see codeTokens for
 * the walk, which the import scan shares. */

// One side of a diff: the text to show, and the 1-based source line each of its lines came from.
export type CodeSide = { text: string; lines: number[] };

// The line of a stripped view showing the file's line `line` — itself when it survived, otherwise the first kept
// line after it, so a jump into a removed comment lands on the code that comment introduces. Past the last kept
// line it is the end of the view. The inverse (`lines[modelLine - 1]`) is what the gutter and the reported
// selection print, which is why nothing outside this module ever sees the view's own numbering.
export const modelLineOf = (lines: readonly number[], line: number): number => {
    const index = lines.findIndex((source) => source >= line);
    return index < 0 ? Math.max(lines.length, 1) : index + 1;
};

// A token stack is a comment when any scope in it is `comment` or below. Leading indentation is scoped
// `punctuation.whitespace.comment.leading…`, which deliberately does NOT match — it is whitespace either way.
const isComment = (scopes: readonly string[]): boolean => scopedAs(scopes, `comment`);

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

// `text` with every comment removed, or undefined when the walk couldn't finish — no grammar for `lang` (an
// unknown extension, plaintext) or out of budget, and a part-stripped file is worse than the file itself. The
// caller then shows the file verbatim.
export const stripComments = async (text: string, lang: string | undefined): Promise<CodeSide | undefined> => {
    const kept: string[] = [];
    const lines: number[] = [];
    let dropped = false;
    const walked = await walkTokens(text, lang, (line, tokens, index) => {
        // An untokenized line has no comment we can see, so it stays whole.
        const code = tokens === undefined ? line : stripLine(line, tokens);
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
    if (!walked) {
        return undefined;
    }
    return { text: kept.join(`\n`), lines };
};
