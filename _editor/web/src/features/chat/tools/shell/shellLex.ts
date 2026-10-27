// A shell command line read the way a reader needs it, not the way bash runs it: coloured pieces for the card's row and
// fold (every character kept, so the pieces join back into the line exactly), and the statements it runs, each a
// pipeline of argument lists with the quotes taken off, for shellOutput.ts to recognise. Never throws: an unbalanced
// quote runs to the end of the line, as the reader would see it anyway.

export type ShellTokenKind = `program` | `flag` | `string` | `variable` | `operator` | `separator` | `word` | `comment` | `space`;

export interface ShellToken {
    readonly kind: ShellTokenKind;
    readonly text: string;
}

// One command of a pipeline: its words with quotes removed, and which of them the shell would still expand (a variable,
// a substitution, a glob), since a path that only exists once expanded cannot be named.
export interface ShellCommand {
    readonly argv: readonly string[];
    readonly expands: readonly boolean[];
}

// What runs between two separators (`;`, `&&`, `||`, `&`, a newline). `from`/`to` index `tokens`; `next` is the first
// token of the following statement, past its separator and the space after it.
export interface ShellStatement {
    readonly pipeline: readonly ShellCommand[];
    readonly separator: string | undefined;
    readonly from: number;
    readonly next: number;
}

export interface ShellLine {
    readonly tokens: readonly ShellToken[];
    readonly statements: readonly ShellStatement[];
    // A here-document's body is text, not commands: its statements are not to be trusted.
    readonly heredoc: boolean;
}

const SEPARATORS = new Set([`&&`, `||`, `;`, `&`, `\n`]);
// Keywords that leave the next word a program (`if grep …`, `do sed …`), coloured as the program they introduce.
const LEADING_KEYWORDS = new Set([
    `if`,
    `then`,
    `else`,
    `elif`,
    `do`,
    `while`,
    `until`,
    `time`,
    `!`,
    `exec`,
    `xargs`,
    `sudo`,
    `env`,
    `nice`,
    `timeout`,
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Redirections, longest first: `2>&1`, `&>>`, `>>`, `<<<`, `<<-`, `>&2`.
const REDIRECT = /^(?:\d*(?:>>|>&|>\||>|<<<|<<-|<<|<&|<>|<)|&>>|&>)(?:\d+(?![^\s;&|<>()])|-(?![^\s;&|<>()]))?/;
const OPERATOR = /^(?:&&|\|\||;;|\|&|\||;|&|\(|\))/;

interface RawWord {
    readonly kind: `word`;
    readonly tokens: ShellToken[];
    value: string;
    expands: boolean;
}

interface RawOp {
    readonly kind: `op`;
    readonly token: ShellToken;
}

interface RawGap {
    readonly kind: `gap`;
    readonly token: ShellToken;
}

type Raw = RawWord | RawOp | RawGap;

// Reads to the closing `close`, honouring backslash escapes where `escapes`; returns the index past it (or the end).
const closing = (line: string, from: number, close: string, escapes: boolean): number => {
    for (let at = from; at < line.length; at += 1) {
        const char = line[at];
        if (escapes && char === `\\`) {
            at += 1;
            continue;
        }
        if (char === close) {
            return at + 1;
        }
    }
    return line.length;
};

// `$( … )` with its own nesting and quotes, so `$(git rev-parse "a)b")` closes where the shell would.
const closingParen = (line: string, from: number): number => {
    let depth = 1;
    for (let at = from; at < line.length; at += 1) {
        const char = line[at];
        if (char === `\\`) {
            at += 1;
        } else if (char === `'`) {
            at = closing(line, at + 1, `'`, false) - 1;
        } else if (char === `"`) {
            at = closing(line, at + 1, `"`, true) - 1;
        } else if (char === `(`) {
            depth += 1;
        } else if (char === `)`) {
            depth -= 1;
            if (depth === 0) {
                return at + 1;
            }
        }
    }
    return line.length;
};

const unescapeDouble = (inner: string): string => inner.replace(/\\([\\$`"\n])/g, `$1`);

const WORD_STOP = /[\s;&|<>()]/;

// One quoted or expanded piece of a word starting at `at`, or undefined for a plain character.
interface Piece {
    readonly kind: `string` | `variable`;
    readonly end: number;
    readonly value: string;
    readonly expands: boolean;
}

const VARIABLE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?@*#$!-])/;

const quotedPiece = (line: string, at: number): Piece | undefined => {
    const char = line[at];
    if (char === `'` || line.startsWith(`$'`, at)) {
        const open = char === `'` ? at + 1 : at + 2;
        const end = closing(line, open, `'`, char !== `'`);
        return { kind: `string`, end, value: line.slice(open, line[end - 1] === `'` ? end - 1 : end), expands: false };
    }
    if (char === `"`) {
        const end = closing(line, at + 1, `"`, true);
        const inner = line.slice(at + 1, line[end - 1] === `"` ? end - 1 : end);
        return { kind: `string`, end, value: unescapeDouble(inner), expands: /\$|`/.test(inner) };
    }
    return undefined;
};

const expansionEnd = (line: string, at: number): number | undefined => {
    if (line.startsWith(`$(`, at)) {
        return closingParen(line, at + 2);
    }
    if (line.startsWith(`\${`, at)) {
        return closing(line, at + 2, `}`, false);
    }
    if (line[at] === `\``) {
        return closing(line, at + 1, `\``, true);
    }
    const name = VARIABLE.exec(line.slice(at, at + 64))?.[0];
    return name === undefined ? undefined : at + name.length;
};

const expansionPiece = (line: string, at: number): Piece | undefined => {
    const end = expansionEnd(line, at);
    return end === undefined ? undefined : { kind: `variable`, end, value: line.slice(at, end), expands: true };
};

// One word, from `start`: quoted runs as strings, expansions as variables, the rest as plain runs (classified later).
const readWord = (line: string, start: number): RawWord & { readonly end: number } => {
    const word: RawWord = { kind: `word`, tokens: [], value: ``, expands: false };
    let plain = ``;
    let at = start;
    while (at < line.length && !WORD_STOP.test(line[at]!)) {
        const piece = quotedPiece(line, at) ?? expansionPiece(line, at);
        if (piece !== undefined) {
            if (plain !== ``) {
                word.tokens.push({ kind: `word`, text: plain });
                plain = ``;
            }
            word.tokens.push({ kind: piece.kind, text: line.slice(at, piece.end) });
            word.value += piece.value;
            word.expands ||= piece.expands;
            at = piece.end;
            continue;
        }
        // A backslash keeps the character after it, which then means itself.
        const width = line[at] === `\\` && at + 1 < line.length ? 2 : 1;
        const char = line[at + width - 1]!;
        plain += line.slice(at, at + width);
        word.value += char;
        word.expands ||= width === 1 && (char === `*` || char === `?` || char === `[` || (char === `~` && at === start));
        at += width;
    }
    if (plain !== ``) {
        word.tokens.push({ kind: `word`, text: plain });
    }
    return { ...word, end: at };
};

// The token a line holds at `at` that is not a word: a run of space, a comment, a redirect or an operator.
const readNonWord = (line: string, at: number, previous: Raw | undefined): RawOp | RawGap | undefined => {
    const rest = line.slice(at, at + 64);
    const space = /^(?:\\\n|[ \t\r])+/.exec(line.slice(at))?.[0];
    if (space !== undefined) {
        return { kind: `gap`, token: { kind: `space`, text: space } };
    }
    if (line[at] === `#` && previous?.kind !== `word`) {
        const end = line.indexOf(`\n`, at);
        return { kind: `gap`, token: { kind: `comment`, text: end === -1 ? line.slice(at) : line.slice(at, end) } };
    }
    const redirect = REDIRECT.exec(rest)?.[0];
    if (redirect !== undefined) {
        return { kind: `op`, token: { kind: `operator`, text: redirect } };
    }
    const operator = line[at] === `\n` ? `\n` : OPERATOR.exec(rest)?.[0];
    return operator === undefined ? undefined : { kind: `op`, token: { kind: SEPARATORS.has(operator) ? `separator` : `operator`, text: operator } };
};

const lexRaw = (line: string): Raw[] => {
    const raws: Raw[] = [];
    let at = 0;
    while (at < line.length) {
        const other = readNonWord(line, at, raws.at(-1));
        if (other !== undefined) {
            raws.push(other);
            at += other.token.text.length;
            continue;
        }
        const { end, ...word } = readWord(line, at);
        // A stop character neither reader could take (a lone `<` the redirect pattern refused): taken as it is.
        if (end === at) {
            raws.push({ kind: `op`, token: { kind: `operator`, text: line[at]! } });
            at += 1;
        } else {
            raws.push(word);
            at = end;
        }
    }
    return raws;
};

// Colours the plain runs by where they stand: the first word of each command is its program, a word that starts with
// `-` is a flag, a leading `NAME=value` is an assignment.
const classify = (raws: readonly Raw[]): void => {
    let commandStart = true;
    let afterRedirect = false;
    for (const raw of raws) {
        if (raw.kind === `gap`) {
            continue;
        }
        if (raw.kind === `op`) {
            const text = raw.token.text;
            commandStart = raw.token.kind === `separator` || text === `|` || text === `|&` || text === `(`;
            afterRedirect = raw.token.kind === `operator` && /[<>]/.test(text) && !/&\d*$/.test(text) && !/^\d*[<>]&?\d+$/.test(text);
            continue;
        }
        const first = raw.tokens[0];
        if (afterRedirect) {
            afterRedirect = false;
            continue;
        }
        if (commandStart && ASSIGNMENT.test(raw.value)) {
            raw.tokens.forEach((token, index) => {
                if (token.kind === `word`) {
                    raw.tokens[index] = { kind: `variable`, text: token.text };
                }
            });
            continue;
        }
        if (commandStart) {
            raw.tokens.forEach((token, index) => {
                if (token.kind === `word`) {
                    raw.tokens[index] = { kind: `program`, text: token.text };
                }
            });
            commandStart = LEADING_KEYWORDS.has(raw.value);
            continue;
        }
        if (first?.kind === `word` && first.text.startsWith(`-`)) {
            raw.tokens[0] = { kind: `flag`, text: first.text };
        }
    }
};

const isRedirect = (token: ShellToken): boolean => token.kind === `operator` && /[<>]/.test(token.text);
// A redirect that names its own target (`2>&1`, `>&2`) takes no word after it.
const redirectTakesWord = (text: string): boolean => !/&\d*$/.test(text) && !/^\d*[<>]&?\d+$/.test(text) && !text.endsWith("-");

export const lexShell = (line: string): ShellLine => {
    const raws = lexRaw(line);
    classify(raws);
    const tokens: ShellToken[] = [];
    const statements: ShellStatement[] = [];
    let heredoc = false;
    let pipeline: ShellCommand[] = [];
    let argv: string[] = [];
    let expands: boolean[] = [];
    let from = 0;
    let skipNext = false;
    const endCommand = (): void => {
        if (argv.length > 0) {
            pipeline.push({ argv, expands });
        }
        argv = [];
        expands = [];
    };
    const endStatement = (separator: string | undefined, next: number): void => {
        endCommand();
        if (pipeline.length > 0) {
            statements.push({ pipeline, separator, from, next });
        }
        pipeline = [];
        from = next;
    };
    for (const [index, raw] of raws.entries()) {
        if (raw.kind === `word`) {
            tokens.push(...raw.tokens);
            if (skipNext) {
                skipNext = false;
            } else {
                argv.push(raw.value);
                expands.push(raw.expands);
            }
            continue;
        }
        tokens.push(raw.token);
        if (raw.kind === `gap`) {
            continue;
        }
        const text = raw.token.text;
        if (raw.token.kind === `separator`) {
            // The next statement starts past this separator and any space after it.
            const following = raws[index + 1];
            const next = tokens.length + (following?.kind === `gap` && following.token.kind === `space` ? 1 : 0);
            endStatement(text, next);
        } else if (text === `|` || text === `|&`) {
            endCommand();
        } else if (isRedirect(raw.token)) {
            heredoc ||= text.startsWith(`<<`) && !text.startsWith(`<<<`);
            skipNext = redirectTakesWord(text);
        }
    }
    endStatement(undefined, tokens.length);
    return { tokens, statements, heredoc };
};

// A leading `cd DIR &&` (or `;`): where the rest runs, which the row need not repeat on every call.
export const leadingCd = (line: ShellLine): { readonly dir: string; readonly next: number } | undefined => {
    const first = line.statements[0];
    const command = first?.pipeline[0];
    if (
        first === undefined ||
        command === undefined ||
        first.pipeline.length !== 1 ||
        command.argv[0] !== `cd` ||
        command.argv.length !== 2 ||
        command.expands[1] === true ||
        (first.separator !== `&&` && first.separator !== `;`) ||
        line.statements.length < 2
    ) {
        return undefined;
    }
    return { dir: command.argv[1]!, next: first.next };
};

// The command split into one row per statement for the fold: each row ends with its own separator, and the space after
// a separator is dropped since the break stands in for it. A newline separator is the break itself.
export const commandRows = (tokens: readonly ShellToken[]): ShellToken[][] => {
    const rows: ShellToken[][] = [[]];
    for (const [index, token] of tokens.entries()) {
        const previous = tokens[index - 1];
        if (token.kind === `space` && previous?.kind === `separator`) {
            continue;
        }
        if (token.kind === `separator`) {
            if (token.text !== `\n`) {
                rows.at(-1)!.push(token);
            }
            rows.push([]);
            continue;
        }
        rows.at(-1)!.push(token);
    }
    return rows.filter((row) => row.length > 0);
};
