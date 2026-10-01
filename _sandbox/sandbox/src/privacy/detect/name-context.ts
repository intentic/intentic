import { type Announcer, announcerOf } from "./lexicon.js";
import { isDigit, isLetter, isWordChar } from "./text.js";

// What the text around a capitalized word says about it: whether it is code, whether a title or a field name
// announces it, whether it sits in a line of data. The name rules ask; this answers by looking a few characters out.

export interface Line {
    readonly start: number;
    readonly end: number;
    // Looks like source code: names there count only as quoted values.
    readonly code: boolean;
    // A row of upper-case data ("1|JAN|KOWALSKI|…"), the only place an all-caps word may be a name.
    readonly upperData: boolean;
}

// A line of source code, or of machine output about code: a statement or declaration, a line ending in a brace or a
// call, a comment, a commit (a hash first, or a conventional-commit subject). A CSV row ending in ";" is not one, and
// neither is a sentence ending in a bracketed remark ("Zadzwoń do Zbigniewa (pilne)"): a call has no space before "(".
const CODE_LINE = new RegExp(
    [
        String.raw`^\s*(?:import|export|from|const|let|var|function|def|class|return|if|else|elif|for|while|switch|case|public|private|protected|static|async|await|package|using|namespace|interface|type|enum|struct|fn|impl|pub|use|mod|#include|@\w+)\b`,
        String.raw`[{}]\s*$|[\w$]\([^()]*\)\s*;?\s*$|=>|\)\s*\{|\bnew\s+\p{Lu}\w*\(|^\s*(?:\/\/|\/\*)`,
        String.raw`^\s*[0-9a-f]{7,40}\s|^\s*(?:fix|feat|chore|docs|refactor|test|perf|build|ci|style|revert)(?:\([^)]*\))?!?:`,
    ].join("|"),
    "u",
);
const STATEMENT_END = /;\s*$/u;
const UPPER = /\p{Lu}/gu;
const LOWER = /\p{Ll}/gu;
const CELL_SEPARATOR = /[|;,\t]/;
const MAX_UPPER_WORDS = 6;

const describeLine = (text: string, start: number, end: number): Line => {
    const line = text.slice(start, end);
    const upper = line.match(UPPER)?.length ?? 0;
    const lower = line.match(LOWER)?.length ?? 0;
    const shortOrCells = CELL_SEPARATOR.test(line) || line.trim().split(/\s+/).length <= MAX_UPPER_WORDS;
    // An assignment ending in ";" is a statement; tested apart because "=.*;$" in one pattern rescans a long minified
    // line from every "=".
    const statement = STATEMENT_END.test(line) && line.includes("=");
    return { start, end, code: statement || CODE_LINE.test(line), upperData: upper > 0 && lower * 10 <= upper && shortOrCells };
};

// The line a position is on. Positions are asked in increasing order, so the current line is kept and each line is
// found and described once: a minified file is one long line, and finding its bounds per word would be quadratic.
export const lineCursor = (text: string): ((index: number) => Line) => {
    let current: Line | undefined;
    return (index) => {
        if (current === undefined || index < current.start || index >= current.end) {
            const start = index === 0 ? 0 : text.lastIndexOf("\n", index - 1) + 1;
            const newline = text.indexOf("\n", index);
            current = describeLine(text, start, newline === -1 ? text.length : newline + 1);
        }
        return current;
    };
};

// Not "*" or "_" before: markdown emphasis wraps names as often as anything else.
const CODE_BEFORE = new Set(["@", "#", "$", "\\", "/", "<", "&", "%", "~", "^", "`", "+", "-"]);
const CODE_AFTER = new Set(["(", "<", "[", "{", "/", "\\", "@", "_", "`", "=", "-"]);

// A word glued to code punctuation is an identifier, a path segment or markup: obj.Name, Name(), Name::new, <Name>,
// @Name, $Name, /home/Name/, --Name, Name=value, Name.txt. Also "Don't", which splits into a name and a contraction.
export const codeAdjacent = (text: string, start: number, end: number): boolean => {
    const before = text[start - 1] ?? "";
    const after = text[end] ?? "";
    if (CODE_BEFORE.has(before) || CODE_AFTER.has(after)) {
        return true;
    }
    if ((before === "." && isWordChar(text[start - 2])) || (before === ":" && text[start - 2] === ":")) {
        return true;
    }
    if ((after === "." && isWordChar(text[end + 1])) || (after === ":" && text[end + 1] === ":")) {
        return true;
    }
    return (after === "'" || after === "’") && text[end + 1] === "t" && !isLetter(text[end + 2]);
};

// Names that are also months or a volume: "Jan 5", "5 Jan 2024", "Tom 2", "3 Maja". Next to a number they are dates.
const DATE_WORDS = new Set(["jan", "maja", "tom", "may", "june", "april", "august"]);

export const besideNumber = (text: string, start: number, end: number, lower: string): boolean => {
    if (!DATE_WORDS.has(lower)) {
        return false;
    }
    const after = text.slice(end, end + 3);
    return /^\.? ?\d/.test(after) || isDigit(text[start - 1]) || (text[start - 1] === " " && isDigit(text[start - 2]));
};

// The word before, read backwards over spaces and an optional dot: "Pan Kowalski", "dr hab. Nowak", "Mr. Smith".
export const announcedBy = (text: string, start: number): Announcer | undefined => {
    let index = start - 1;
    let spaces = 0;
    while (index >= 0 && text[index] === " " && spaces < 3) {
        index -= 1;
        spaces += 1;
    }
    const dotted = text[index] === ".";
    if (dotted) {
        index -= 1;
    } else if (spaces === 0) {
        return undefined;
    }
    const end = index + 1;
    while (index >= 0 && end - index <= 20 && isLetter(text[index])) {
        index -= 1;
    }
    return end - index > 1 && !isWordChar(text[index]) ? announcerOf(text.slice(index + 1, end), dotted) : undefined;
};

// A field, header or greeting that says the value after it is a person: lastName=…, "author": …, Author: …, From: …,
// "Cześć Marek", "Dear Mark". A bare "name" field says less: sheets, products and builds have names too.
const PERSON_FIELD =
    /(?:(?:first|last|full|display|given|family|middle|user|contact|customer|client|author|owner|person|patient|employee)[ _-]?name|surname|nazwisko|imi[eę]|imiona|author|autor|owner|w[łl]a[śs]ciciel|contact|kontakt|person|osoba|klient|customer|employee|pracownik|patient|pacjent|recipient|odbiorca|nadawca|sender|assignee|reviewer|signer|user|u[żz]ytkownik)["']?\s*[:=]\s*["']?$/iu;
const NAME_FIELD = /name["']?\s*[:=]\s*["']?$/iu;
const HEADER =
    /^\s*(?:from|to|cc|bcc|reply-to|od|do|dw|author|autor|committer|signed-off-by|co-authored-by|reviewed-by|acked-by|tested-by|reported-by)\s*:\s*$/iu;
const GREETING =
    /(?:^|[^\p{L}])(?:hi|hello|hey|dear|thanks|thank you|cheers|cześć|czesc|hej|witaj|witam|drogi|droga|drodzy|szanowny|szanowna|szanowni|pozdrawiam|dziękuję|dziekuje|dzięki|dzieki)[ ,!]*$/iu;
// The closing line of a letter, after which a line of its own is the signature.
const CLOSING = /(?:regards|pozdrawiam|pozdrowienia|cheers|thanks|dziękuję|sincerely|poważaniem|best|wishes),?\s*$/iu;

// How firmly the text before a word says a person follows: "person" (a person's field, a header, a greeting, a
// signature), "name" (a bare name field), or nothing.
export type Label = "person" | "name";

export const labelBefore = (text: string, start: number, line: Line): Label | undefined => {
    const before = text.slice(Math.max(line.start, start - 40), start);
    // A header starts its line, so only a token near the line's start can follow one.
    const header = start - line.start <= 40 && HEADER.test(text.slice(line.start, start));
    if (header || PERSON_FIELD.test(before) || GREETING.test(before)) {
        return "person";
    }
    if (NAME_FIELD.test(before)) {
        return "name";
    }
    if (before.trim() !== "" || line.start < 2) {
        return undefined;
    }
    const previous = text.slice(Math.max(0, line.start - 80), line.start - 1).trimEnd();
    return CLOSING.test(previous.slice(previous.lastIndexOf("\n") + 1)) ? "person" : undefined;
};

// "Jan Kowalski <jan@firma.pl>": a display name before an address in angle brackets, as mail headers and git write it.
const DISPLAY_NAME_ADDRESS = / ?<[^\s<>@]+@[^\s<>]+>/y;

export const addressAfter = (text: string, end: number): boolean => {
    DISPLAY_NAME_ADDRESS.lastIndex = end;
    return DISPLAY_NAME_ADDRESS.test(text);
};

const QUOTES = new Set(['"', "'"]);

// A quoted value of its own: "Anna" in a string literal, a JSON value, a CSV cell.
export const quotedAlone = (text: string, start: number, end: number): boolean => QUOTES.has(text[start - 1] ?? "") && QUOTES.has(text[end] ?? "");
