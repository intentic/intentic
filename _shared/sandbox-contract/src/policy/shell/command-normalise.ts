import type { CommandContext, CommandSpan } from "../command-classes.js";

// A command with the quoting a shell strips before it runs anything, so `r\m`, `r''m`, `"rm"`, `$'\x72m'` and
// `rm${IFS}-rf` read as the `rm -rf` they are; the classifier runs its tables over this copy as well as the command.
// A quoted piece with no whitespace in it only joins word fragments and loses its quotes. One with whitespace is a
// single argument and keeps them, but its inside is read the same way, as the nested shell of a `bash -c "…"` would.
// Over-reading costs a judge call, the trade the classifier makes everywhere. Each character keeps the slice of the
// command it came from, so a fragment found here still marks the text the card shows, and still asks `live` of it.

interface Reading {
    text: string;
    // Per UTF-16 unit of `text`, the slice of the command it was read from.
    readonly sources: CommandSpan[];
}

const reading = (): Reading => ({ text: "", sources: [] });

const emit = (into: Reading, text: string, start: number, end: number): void => {
    into.text += text;
    for (let unit = 0; unit < text.length; unit += 1) {
        into.sources.push({ start, end });
    }
};

// A quote's inside, its first and last characters stretched over the quotes it lost, so a mark covers them too.
const append = (into: Reading, piece: Reading, start: number, end: number): void => {
    into.text += piece.text;
    const last = piece.sources.length - 1;
    piece.sources.forEach((source, unit) => into.sources.push({ start: unit === 0 ? start : source.start, end: unit === last ? end : source.end }));
};

type QuoteKind = "single" | "double" | "ansi";

// `$"…"` is a translated string, read as a plain double-quoted one.
const openerAt = (command: string, index: number, end: number): { readonly kind: QuoteKind; readonly width: number } | undefined => {
    const pair = command.slice(index, Math.min(index + 2, end));
    if (pair.startsWith("'") || pair.startsWith('"')) {
        return { kind: pair.startsWith("'") ? "single" : "double", width: 1 };
    }
    return pair === "$'" ? { kind: "ansi", width: 2 } : pair === '$"' ? { kind: "double", width: 2 } : undefined;
};

// Where a quote closes, or -1 when it runs off the end; only a single quote can't escape its closer.
const closingQuote = (command: string, start: number, end: number, kind: QuoteKind): number => {
    const quote = kind === "double" ? '"' : "'";
    for (let index = start; index < end; index += 1) {
        if (kind !== "single" && command[index] === "\\") {
            index += 1;
        } else if (command[index] === quote) {
            return index;
        }
    }
    return -1;
};

const ANSI_C_ESCAPE = /\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|([\s\S]))/y;
const ANSI_C_NAMED = new Map([
    ["a", "\x07"],
    ["b", "\b"],
    ["e", "\x1b"],
    ["E", "\x1b"],
    ["f", "\f"],
    ["n", "\n"],
    ["r", "\r"],
    ["t", "\t"],
    ["v", "\v"],
]);

// One `$'…'` escape as bash expands it. One with no meaning (`\m`) keeps its backslash in bash and loses it here,
// which reads a little more, never less.
const ansiCharacter = (escape: RegExpExecArray): string => {
    const [whole, hex, short, long, octal, named = ""] = escape;
    const code = hex ?? short ?? long;
    if (code !== undefined) {
        const point = Number.parseInt(code, 16);
        return point <= 0x10_ff_ff ? String.fromCodePoint(point) : whole;
    }
    return octal === undefined ? (ANSI_C_NAMED.get(named) ?? named) : String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
};

// Inside double quotes a backslash only escapes these (a newline it removes); before anything else it is a character.
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);

// What a backslash at `index` stands for inside each kind of quote, and how many characters it took; undefined
// where it is only a backslash.
type EscapeReader = (command: string, index: number) => { readonly text: string; readonly width: number } | undefined;

const ESCAPES = {
    single: () => undefined,
    double: (command, index) => {
        const next = command.charAt(index + 1);
        return DOUBLE_QUOTE_ESCAPES.has(next) ? { text: next === "\n" ? "" : next, width: 2 } : undefined;
    },
    ansi: (command, index) => {
        ANSI_C_ESCAPE.lastIndex = index;
        const escape = ANSI_C_ESCAPE.exec(command);
        return escape === null ? undefined : { text: ansiCharacter(escape), width: escape[0].length };
    },
} satisfies Record<QuoteKind, EscapeReader>;

// A quote's inside as the shell hands it over. A closer is never escaped, so no escape here runs past `end`.
const quotedPiece = (command: string, start: number, end: number, kind: QuoteKind): Reading => {
    const piece = reading();
    let index = start;
    while (index < end) {
        const escape = command.charAt(index) === "\\" ? ESCAPES[kind](command, index) : undefined;
        const width = escape?.width ?? 1;
        emit(piece, escape?.text ?? command.charAt(index), index, index + width);
        index += width;
    }
    return piece;
};

// `${IFS}` and `$IFS` (not `$IFSX`, another variable): the field separator, which splits words as a space does.
const ifsWidth = (command: string, index: number): number => {
    if (command.startsWith("${IFS}", index)) {
        return 6;
    }
    return command.startsWith("$IFS", index) && !/\w/.test(command.charAt(index + 4)) ? 4 : 0;
};

// The quote opening at `index`, read into `into`; where reading resumes, or undefined when nothing opens there or
// nothing closes it (an unterminated quote never runs: the shell waits for more).
const readQuote = (into: Reading, command: string, index: number, end: number): number | undefined => {
    const opener = openerAt(command, index, end);
    if (opener === undefined) {
        return undefined;
    }
    const inside = index + opener.width;
    const close = closingQuote(command, inside, end, opener.kind);
    if (close === -1) {
        return undefined;
    }
    const piece = quotedPiece(command, inside, close, opener.kind);
    // `$'…'` exists to spell characters, so it is always read spelled out.
    if (opener.kind === "ansi" || !/\s/.test(piece.text)) {
        append(into, piece, index, close + 1);
        return close + 1;
    }
    emit(into, command.slice(index, inside), index, inside);
    readRange(into, command, inside, close);
    emit(into, command.charAt(close), close, close + 1);
    return close + 1;
};

// One escape, `$IFS`, quote or plain character at `index`; where the next one starts.
const readOne = (into: Reading, command: string, index: number, end: number): number => {
    // A line continuation joins its two lines; any other escaped character is just itself.
    if (command.charAt(index) === "\\" && index + 1 < end) {
        const escaped = command.charAt(index + 1);
        emit(into, escaped === "\n" ? "" : escaped, index, index + 2);
        return index + 2;
    }
    const ifs = ifsWidth(command, index);
    if (ifs > 0) {
        emit(into, " ", index, index + ifs);
        return index + ifs;
    }
    const quoted = readQuote(into, command, index, end);
    if (quoted !== undefined) {
        return quoted;
    }
    emit(into, command.charAt(index), index, index + 1);
    return index + 1;
};

const readRange = (into: Reading, command: string, start: number, end: number): void => {
    let index = start;
    while (index < end) {
        index = readOne(into, command, index, end);
    }
};

// The unquoted copy, and the way back from a span over it to the slice of the command it was read from.
export interface NormalisedCommand {
    readonly text: string;
    readonly original: (span: CommandSpan) => CommandSpan;
}

// Undefined when there is no quoting to strip, so a caller has nothing more to read.
export const normaliseCommand = (command: string): NormalisedCommand | undefined => {
    const copy = reading();
    readRange(copy, command, 0, command.length);
    if (copy.text === command) {
        return undefined;
    }
    return {
        text: copy.text,
        original: (span) => {
            const start = copy.sources[span.start]?.start ?? command.length;
            return { start, end: span.end > span.start ? (copy.sources[span.end - 1]?.end ?? start) : start };
        },
    };
};

type Matcher = (text: string, context: CommandContext) => CommandSpan[];

// One matcher over both readings of a command, as written and unquoted, every span over the command's own offsets. The
// unquoting is done once, however many matchers ask, and the context's file check once per path, though both readings
// may name it.
export const readingsOf = (command: string, context: CommandContext): ((read: Matcher) => CommandSpan[]) => {
    const unquoted = normaliseCommand(command);
    const asked = new Map<string, boolean | undefined>();
    const holdsSecret = (path: string): boolean | undefined => {
        if (!asked.has(path)) {
            asked.set(path, context.holdsSecret?.(path));
        }
        return asked.get(path);
    };
    const once: CommandContext = { ...context, holdsSecret };
    return (read) => [...read(command, once), ...(unquoted === undefined ? [] : read(unquoted.text, once).map(unquoted.original))];
};
