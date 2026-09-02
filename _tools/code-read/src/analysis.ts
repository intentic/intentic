import { isBlank, leadToken, scopedAs, type Grammars, type Token, walkTokens } from "./tokens.js";

/* The two structural readings a review needs from one TextMate walk: the comment-free source it renders and
 * the import lines it may scroll past. Keeping them together matters because tokenizing is overwhelmingly the
 * expensive part; collecting another answer while visiting the same tokens is effectively free. */

export interface CodeSide {
    readonly text: string;
    readonly lines: number[];
}

export interface CodeAnalysis {
    readonly code: CodeSide;
    /** One-based line numbers in the original source. */
    readonly imports: number[];
}

const isComment = (scopes: readonly string[]): boolean => scopedAs(scopes, `comment`);

// The line without its trailing comment, or undefined when the comment was all it held. Only a trailing run is
// cut: a comment wedged between code (`f(/* n */ 1)`) stays rather than splicing the statement around it.
const stripLine = (line: string, tokens: readonly Token[]): string | undefined => {
    let cut = -1;
    for (const token of tokens.toReversed()) {
        if (isComment(token.scopes)) {
            cut = token.startIndex;
            continue;
        }
        if (isBlank(line.slice(token.startIndex, token.endIndex))) {
            continue;
        }
        break;
    }
    if (cut < 0) {
        return line;
    }
    const kept = line.slice(0, cut).trimEnd();
    return kept === `` ? undefined : kept;
};

/* Scope families that name an import. Matching the dotted family keeps lookalikes such as SCSS's @include
 * mixin and C#'s using statement out; codeLanding.test.ts pins the language-specific cases. */
const IMPORT_SCOPES = [
    `meta.import`,
    `keyword.control.import`,
    `meta.use`,
    `meta.include`,
    `meta.preprocessor.include`,
    `meta.require`,
    `meta.at-rule.import`,
    `meta.at-rule.use`,
    `keyword.other.directive.using`,
];

const OPENING = `([{`;
const CLOSING = `)]}`;

const opensImport = (token: Token): boolean => IMPORT_SCOPES.some((family) => scopedAs(token.scopes, family));

// Brackets this line leaves open. Strings and comments are skipped, so punctuation inside either cannot carry an
// import onto the next line. An untokenized overlong line opens nothing.
const openedBy = (line: string, tokens: readonly Token[] | undefined): number => {
    let depth = 0;
    for (const token of tokens ?? []) {
        if (scopedAs(token.scopes, `string`) || isComment(token.scopes)) {
            continue;
        }
        for (const char of line.slice(token.startIndex, token.endIndex)) {
            if (OPENING.includes(char)) {
                depth += 1;
            }
            if (CLOSING.includes(char)) {
                depth -= 1;
            }
        }
    }
    return depth;
};

/**
 * Analyze `text` in one token walk, or return undefined if its grammar is unavailable or abandons the walk.
 * A partial answer is never returned: callers then consistently show the untouched source and git's own stats.
 */
export const analyzeCode = async (text: string, lang: string | undefined, grammars: Grammars): Promise<CodeAnalysis | undefined> => {
    const kept: string[] = [];
    const lines: number[] = [];
    const imports: number[] = [];
    let dropped = false;
    let openImport = 0;

    const walked = await walkTokens(text, lang, grammars, (line, tokens, index) => {
        const lead = tokens === undefined ? undefined : leadToken(line, tokens);
        if (lead !== undefined && (openImport > 0 || opensImport(lead))) {
            imports.push(index + 1);
            openImport = Math.max(0, openImport + openedBy(line, tokens));
        }

        // An untokenized line has no comment we can see, so it stays whole.
        const code = tokens === undefined ? line : stripLine(line, tokens);
        // A comment block almost always sits between two blank lines. Removing it would leave both behind, so a
        // blank that follows a removal and another blank collapses into the one already kept.
        if (code === undefined || (dropped && isBlank(code) && isBlank(kept.at(-1) ?? ``))) {
            dropped = true;
            return;
        }
        dropped = false;
        kept.push(code);
        lines.push(index + 1);
    });

    return walked ? { code: { text: kept.join(`\n`), lines }, imports } : undefined;
};

// The model line showing source `line`: itself when kept, otherwise the first surviving line after it.
export const modelLineOf = (lines: readonly number[], line: number): number => {
    const index = lines.findIndex((source) => source >= line);
    return index < 0 ? Math.max(lines.length, 1) : index + 1;
};
