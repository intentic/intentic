// Marks command text that is not a program, so the un-waivable hard-rule tier stops firing inside comments, heredoc
// bodies, and quoted arguments of verbs that can't execute them (echo, grep, a -m message). Missing a region costs one
// judge call; inventing one only skips the hard rule, never the judge. sed/awk/perl are excluded: each can run its own
// argument.

import type { CommandSpan } from "../policy/command-classes.js";

// Verbs whose quoted argument this scanner treats as text; each prints or matches it, none executes it.
const QUOTING_VERBS: ReadonlySet<string> = new Set([
    "echo",
    "printf",
    "rg",
    "grep",
    "egrep",
    "fgrep",
    "ack",
    "ag",
    "ripgrep",
]);

// A message flag (git's -m, etc.): the quoted argument is prose, whatever verb precedes it.
const MESSAGE_FLAGS: ReadonlySet<string> = new Set(["-m", "--message", "-am", "--body", "-b"]);

// Where an unquoted word ends: whitespace, a pipeline/list operator, a redirect, a paren.
const WORD_END = /[\s;|&<>()]/;

// A variable-assignment prefix (`FOO=bar cmd`), skipped when looking for the verb.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// `<<EOF`, `<<-EOF`, quoted or not; the delimiter's quoting only affects expansion, not classification here.
const HEREDOC_OPEN = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

// Found in their own pass, first: a heredoc body is line-oriented and can hold anything, an odd quote count in it would
// desync the word scanner.
const heredocBodies = (command: string): CommandSpan[] => {
    const bodies: CommandSpan[] = [];
    for (const open of command.matchAll(HEREDOC_OPEN)) {
        const indented = command.slice(open.index, open.index + 3).startsWith("<<-");
        const newline = command.indexOf("\n", open.index + open[0].length);
        if (newline === -1) {
            // An unterminated heredoc (nothing after the opener): no body to mark.
            continue;
        }
        const start = newline + 1;
        const terminator = new RegExp(`^${indented ? "[ \\t]*" : ""}${open[2] as string}[ \\t]*$`, "m");
        const rest = command.slice(start);
        const end = terminator.exec(rest)?.index;
        // An unterminated body runs to the end of the command, same as the shell would read it.
        bodies.push({ start, end: end === undefined ? command.length : start + end });
    }
    return bodies;
};

// Is this offset inside an already-found span? Heredoc bodies are skipped wholesale by the word scan.
const within = (spans: readonly CommandSpan[], offset: number): CommandSpan | undefined =>
    spans.find((span) => offset >= span.start && offset < span.end);

// A substitution inside double quotes, the one thing that turns a quoted argument back into a program.
const EXPANDS = /\$\(|`/;

// The span covers the quotes too, so a match anywhere in `"rm -rf /"` reads as contained.
interface QuotedSegment {
    readonly span: CommandSpan;
    // A double-quoted substitution is not text and never becomes a region; single quotes never set this.
    readonly expands: boolean;
}

interface ShellWord {
    readonly start: number;
    // The word with quoting removed, compared against a verb name or a flag.
    readonly text: string;
    readonly quoted: readonly QuotedSegment[];
    // Does this word begin a simple command? True for the first word after a separator or at the start.
    readonly opensCommand: boolean;
}

// A verb by its bare name: `/bin/echo` and `./echo` are both echo, the path says nothing new.
const bareVerb = (text: string): string => text.slice(Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1);

// Every list/pipeline operator; past one, the next word is a verb again.
const SEPARATORS = new Set(["\n", ";", "|", "&", "(", ")"]);
const BLANKS = new Set([" ", "\t", "\r"]);

// An unbalanced quote runs to the end of the command, as a shell waiting for more input would, keeping the caller
// advancing.
const readQuoted = (command: string, open: number): QuotedSegment & { readonly text: string; readonly end: number } => {
    const quote = command[open] as string;
    const close = command.indexOf(quote, open + 1);
    const end = close === -1 ? command.length : close + 1;
    const text = command.slice(open + 1, close === -1 ? command.length : close);
    return { span: { start: open, end }, expands: quote === '"' && EXPANDS.test(text), text, end };
};

// end === start can't happen: the caller only enters here on a character that is neither blank nor a separator.
const readWord = (command: string, start: number): { readonly word: Omit<ShellWord, "opensCommand">; readonly end: number } => {
    const quoted: QuotedSegment[] = [];
    let text = "";
    let index = start;
    while (index < command.length && !WORD_END.test(command[index] as string)) {
        const char = command[index] as string;
        if (char === "'" || char === '"') {
            const segment = readQuoted(command, index);
            quoted.push({ span: segment.span, expands: segment.expands });
            text += segment.text;
            index = segment.end;
            continue;
        }
        if (char === "\\") {
            text += command[index + 1] ?? "";
            index += 2;
            continue;
        }
        text += char;
        index += 1;
    }
    return { word: { start, text, quoted }, end: index };
};

// A scanner, not a parser: tracks quoting and the separators that start a new command, nothing about control flow,
// functions or expansion.
const scanWords = (command: string, skip: readonly CommandSpan[]): ShellWord[] => {
    const words: ShellWord[] = [];
    let index = 0;
    let opensCommand = true;
    while (index < command.length) {
        const skipped = within(skip, index);
        if (skipped !== undefined) {
            index = skipped.end;
            continue;
        }
        const char = command[index] as string;
        if (SEPARATORS.has(char)) {
            opensCommand = true;
            index += 1;
            continue;
        }
        if (BLANKS.has(char)) {
            index += 1;
            continue;
        }
        if (char === "#") {
            // Runs to end of line; only reached at a word boundary, so `a#b` is one word.
            const newline = command.indexOf("\n", index);
            index = newline === -1 ? command.length : newline;
            continue;
        }
        const { word, end } = readWord(command, index);
        // A stray character, neither separator nor word (e.g. a bad redirect): step over it so the loop advances.
        index = end === index ? index + 1 : end;
        if (end !== word.start) {
            words.push({ ...word, opensCommand });
            opensCommand = false;
        }
    }
    return words;
};

// Unsorted and possibly overlapping; callers only ask containment of them. Computed once per command by the classifier
// and shared across every table.
export const inertRegions = (command: string): CommandSpan[] => {
    const bodies = heredocBodies(command);
    const regions: CommandSpan[] = [...bodies];
    const words = scanWords(command, bodies);
    // Found again here, where quoting state lives: a `#` inside a quoted string isn't a comment.
    let quotingVerb = false;
    let previous: ShellWord | undefined;
    for (const word of words) {
        if (word.opensCommand) {
            quotingVerb = QUOTING_VERBS.has(bareVerb(word.text));
            previous = undefined;
        }
        // An env assignment before the verb (`LC_ALL=C grep`) isn't the verb; re-read the next word instead.
        if (word.opensCommand && ASSIGNMENT.test(word.text) && word.quoted.length === 0) {
            quotingVerb = false;
            previous = undefined;
            continue;
        }
        const afterMessageFlag = previous !== undefined && MESSAGE_FLAGS.has(previous.text);
        if (quotingVerb || afterMessageFlag) {
            regions.push(...word.quoted.filter((segment) => !segment.expands).map((segment) => segment.span));
        }
        previous = word;
    }
    regions.push(...commentRegions(command, bodies));
    return regions;
};

// Its own walk: the word scan needs what's inside a quote, this only needs to be past it. Sharing readQuoted keeps both
// agreeing on where one ends.
const commentRegions = (command: string, skip: readonly CommandSpan[]): CommandSpan[] => {
    const comments: CommandSpan[] = [];
    let index = 0;
    while (index < command.length) {
        const skipped = within(skip, index);
        if (skipped !== undefined) {
            index = skipped.end;
            continue;
        }
        const char = command[index] as string;
        if (char === "'" || char === '"') {
            index = readQuoted(command, index).end;
            continue;
        }
        if (char === "\\") {
            index += 2;
            continue;
        }
        // A word boundary before it is what makes it a comment, not part of a word.
        if (char === "#" && (index === 0 || WORD_END.test(command[index - 1] as string))) {
            const newline = command.indexOf("\n", index);
            const end = newline === -1 ? command.length : newline;
            comments.push({ start: index, end });
            index = end;
            continue;
        }
        index += 1;
    }
    return comments;
};

// Judged on where the fragment starts, not whether the whole match is contained: every pattern begins at the verb, so
// the start is what's found. A verb outside every region stays live no matter what follows it.
export const isLive = (span: CommandSpan, regions: readonly CommandSpan[]): boolean =>
    !regions.some((region) => span.start >= region.start && span.start < region.end);
