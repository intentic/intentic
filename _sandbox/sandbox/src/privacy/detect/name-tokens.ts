import { wordInfo } from "./lexicon.js";
import { besideNumber, codeAdjacent, type Line, lineCursor } from "./name-context.js";
import { isWordChar } from "./text.js";

// The capitalized words of a text that could be part of a name, each with what the name lists say about it, and how
// neighbouring ones are joined. The name rules (names.ts) read only these.

export interface Token {
    readonly start: number;
    readonly end: number;
    readonly line: Line;
    // A first name, and one that is not also an ordinary word.
    readonly first: boolean;
    readonly firstStrong: boolean;
    // A surname: in the register, or written as a -ski, -wicz or -czyk surname; and one that is not an ordinary word.
    readonly surname: boolean;
    readonly surnameStrong: boolean;
    // A surname with a surname's suffix: Nowak, Kowalski, Wójcik, but not Rola.
    readonly surnameSuffixed: boolean;
    // A listed -ski, -wicz or -czyk surname written as one: a surname even alone.
    readonly surnameAlone: boolean;
    // Capitalized and nothing else: a surname only beside an unambiguous first name.
    readonly unknown: boolean;
    readonly never: boolean;
    // A noun of a thing (lexicon.ts): a name right before it is the thing's.
    readonly thing: boolean;
}

// What joins two neighbouring words: spaces (one name, "Jan Kowalski"), or a cell separator (two cells of a row,
// "Jan|Kowalski", reported apart so the row keeps its columns). Anything else ends the run.
export type Join = "space" | "cell";

const CAPITALIZED = /\p{Lu}\p{L}*/gu;
const CAPITALIZED_AT = /\p{Lu}\p{L}*/uy;
// The scheme is bounded so a long dotted run without "://" ("a.b.c.d…") is not rescanned from every dot.
const URL = /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>`]+|\bwww\.[^\s"'<>`]+/giu;
const SPACES = /^[  ]+$/u;
const CELL = /^[ "']*[,;|\t][ "']*$/u;
const MAX_GAP = 8;
// Double-barrelled names have two parts; three allows for "Dołęga-Skłodowska-Curie" and stops there.
const MAX_PARTS = 3;

const isCapitalized = (word: string): boolean => {
    const rest = word.slice(1);
    return rest !== "" && rest === rest.toLowerCase();
};
const isUpper = (word: string): boolean => word.length > 1 && word === word.toUpperCase();

export const joinOf = (text: string, a: Token, b: Token): Join | undefined => {
    if (b.start - a.end > MAX_GAP) {
        return undefined;
    }
    const gap = text.slice(a.end, b.start);
    return SPACES.test(gap) ? "space" : CELL.test(gap) ? "cell" : undefined;
};

const tokenOf = (start: number, end: number, parts: readonly string[], line: Line): Token => {
    const infos = parts.map((part) => wordInfo(part));
    const first = infos.every((info) => info.first);
    const ambiguous = parts.length === 1 && infos.some((info) => info.ambiguous);
    const never = infos.some((info) => info.never);
    // A double-barrelled surname needs one barrel to be a surname: Nowak-Kowalska, Skłodowska-Curie.
    const surname = !never && infos.some((info) => info.surname || info.surnameForm);
    return {
        start,
        end,
        line,
        first: first && !never,
        firstStrong: first && !never && !ambiguous,
        surname,
        surnameStrong: surname && !ambiguous,
        surnameSuffixed: !never && !ambiguous && infos.some((info) => info.surnameSuffix !== undefined || info.surnameForm),
        surnameAlone: !never && !ambiguous && infos.some((info) => info.surnameSuffix === "strong" && info.surnameForm),
        unknown: !first && !surname && !never && !ambiguous,
        never,
        thing: parts.length === 1 && infos.some((info) => info.thing),
    };
};

interface Compound {
    readonly end: number;
    readonly parts: readonly string[];
}

// The end of a hyphenated run of capitalized words starting with `first`, and its parts.
const compound = (text: string, start: number, first: string): Compound => {
    const parts = [first];
    let end = start + first.length;
    while (text[end] === "-" && parts.length < MAX_PARTS) {
        CAPITALIZED_AT.lastIndex = end + 1;
        const next = CAPITALIZED_AT.exec(text);
        if (next === null) {
            break;
        }
        parts.push(next[0]);
        end += 1 + next[0].length;
    }
    return { end, parts };
};

// Ranges of URLs, whose capitalized path segments are not anyone, and a test that walks them in order.
const insideUrls = (text: string): ((index: number) => boolean) => {
    const urls = [...text.matchAll(URL)].map((match) => [match.index, match.index + match[0].length] as const);
    let at = 0;
    return (index) => {
        while (at < urls.length && (urls[at]?.[1] ?? 0) <= index) {
            at += 1;
        }
        return (urls[at]?.[0] ?? Infinity) <= index;
    };
};

// Every capitalized word that could be part of a name, in order. A word glued to code, inside a URL, in mixed case
// (an identifier) or in capitals outside a row of upper-case data is left out.
export const tokenize = (text: string): Token[] => {
    const tokens: Token[] = [];
    const lineOf = lineCursor(text);
    const inUrl = insideUrls(text);
    CAPITALIZED.lastIndex = 0;
    for (let match = CAPITALIZED.exec(text); match !== null; match = CAPITALIZED.exec(text)) {
        const start = match.index;
        if (isWordChar(text[start - 1])) {
            continue;
        }
        const { end, parts } = compound(text, start, match[0]);
        // The scan resumes after the whole compound, so its second part is never a token of its own.
        CAPITALIZED.lastIndex = end;
        if (isWordChar(text[end]) || codeAdjacent(text, start, end) || inUrl(start)) {
            continue;
        }
        const line = lineOf(start);
        const cased = parts.every((part) => isCapitalized(part)) || (line.upperData && parts.every((part) => isUpper(part)));
        if (cased && !(parts.length === 1 && besideNumber(text, start, end, match[0].toLowerCase()))) {
            tokens.push(tokenOf(start, end, parts, line));
        }
    }
    return tokens;
};
