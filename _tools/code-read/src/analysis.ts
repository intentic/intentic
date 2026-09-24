import { isBlank, leadToken, type RuleStack, sameStack, scopedAs, type Grammars, type Token, type TokenWalk, walkLines, walkTokens } from "./tokens.js";

// The two structural readings a review needs from one TextMate walk: the comment-free source, and the lines an import
// may span. Kept together since tokenizing dominates the cost; a second answer from the same walk is nearly free.

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

// The line without its trailing comment, or undefined when the comment was all it held. Only a trailing run is cut; a
// comment wedged between code (`f(/* n */ 1)`) stays.
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

// Scope families naming an import; the dotted match excludes lookalikes like SCSS's @include or C#'s using.
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

// Brackets this line leaves open; strings and comments are skipped, so punctuation inside either can't carry an import
// onward. An untokenized line opens nothing.
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

// Where stripping stands between two lines: everything the next line's reading depends on. Two strips in equal states
// read the same following lines the same way.
export interface StripState {
    readonly stack: RuleStack;
    // Whether the line before was removed, which is what lets a blank after it collapse.
    readonly dropped: boolean;
    // Whether the last kept line is blank (true before any is kept).
    readonly blank: boolean;
}

export const STRIP_START: StripState = { stack: null, dropped: false, blank: true };

export const sameStrip = (a: StripState, b: StripState): boolean => a.dropped === b.dropped && a.blank === b.blank && sameStack(a.stack, b.stack);

// One line's reading: the code it keeps, or undefined when it is removed, and the flags the next line reads.
const stripStep = (line: string, tokens: readonly Token[] | undefined, from: Pick<StripState, "dropped" | "blank">) => {
    // An untokenized line has no comment we can see, so it stays whole.
    const code = tokens === undefined ? line : stripLine(line, tokens);
    // Collapses a blank after a removed comment into the one already kept, avoiding two blanks in a row.
    if (code === undefined || (from.dropped && isBlank(code) && from.blank)) {
        return { code: undefined, dropped: true, blank: from.blank };
    }
    return { code, dropped: false, blank: isBlank(code) };
};

/** The code `lines` keep, read from `from`, and where the reading then stands; undefined if the walk is abandoned. */
export const stripLines = (walk: TokenWalk, lines: readonly string[], from: StripState): { readonly kept: string[]; readonly state: StripState } | undefined => {
    const kept: string[] = [];
    let flags: Pick<StripState, "dropped" | "blank"> = from;
    const walked = walkLines(walk, lines, from.stack, (line, tokens) => {
        const step = stripStep(line, tokens, flags);
        flags = step;
        if (step.code !== undefined) {
            kept.push(step.code);
        }
    });
    return walked === undefined ? undefined : { kept, state: { stack: walked.stack, dropped: flags.dropped, blank: flags.blank } };
};

/** Whether any of `lines`, read from `from`, keeps code; stops at the first that does. Undefined if abandoned. */
export const keepsAny = (walk: TokenWalk, lines: readonly string[], from: StripState): boolean | undefined => {
    let flags: Pick<StripState, "dropped" | "blank"> = from;
    let kept = false;
    const walked = walkLines(walk, lines, from.stack, (line, tokens) => {
        const step = stripStep(line, tokens, flags);
        flags = step;
        kept = step.code !== undefined;
        return kept;
    });
    return walked === undefined ? undefined : kept;
};

/** Analyzes `text` in one token walk; undefined if the grammar is unavailable or the walk is abandoned. */
export const analyzeCode = async (text: string, lang: string | undefined, grammars: Grammars): Promise<CodeAnalysis | undefined> => {
    const kept: string[] = [];
    const lines: number[] = [];
    const imports: number[] = [];
    let flags: Pick<StripState, "dropped" | "blank"> = STRIP_START;
    let openImport = 0;

    const walked = await walkTokens(text, lang, grammars, (line, tokens, index) => {
        const lead = tokens === undefined ? undefined : leadToken(line, tokens);
        if (lead !== undefined && (openImport > 0 || opensImport(lead))) {
            imports.push(index + 1);
            openImport = Math.max(0, openImport + openedBy(line, tokens));
        }
        const step = stripStep(line, tokens, flags);
        flags = step;
        if (step.code !== undefined) {
            kept.push(step.code);
            lines.push(index + 1);
        }
    });

    return walked ? { code: { text: kept.join(`\n`), lines }, imports } : undefined;
};

// The model line showing source `line`: itself when kept, otherwise the first surviving line after it.
export const modelLineOf = (lines: readonly number[], line: number): number => {
    const index = lines.findIndex((source) => source >= line);
    return index < 0 ? Math.max(lines.length, 1) : index + 1;
};
