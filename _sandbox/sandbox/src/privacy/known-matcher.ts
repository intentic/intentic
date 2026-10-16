import { afterEscape, isDigit } from "@intentic/privacy-detect/text";

// Finds every value the vault already holds, wherever it stands as a whole word, in each spelling its kind allows
// (`Spelling`). Indexed by the first few characters of each value as compared rather than as one automaton: the vault
// can hold tens of thousands of values (a taught dataset), and a trie over all of them costs a node per character,
// while a map of short prefixes costs one entry per distinct prefix and a text is scanned once, word start by word start.

// How a value may be written and still be that value. `exact`: as written (one plain word, where case is what tells
// `Mark` from `mark`). `case`: in any case (an e-mail address, whose dots and dashes are its own). `folded`: in any
// case, with its spaces, line breaks, hyphens and underscores anywhere or nowhere (a full name, a document or account
// number): `Jan Kowalski`, `JAN  KOWALSKI`, `jan_kowalski`, `JanKowalski`, `ACME-0042-XK`, `acme0042xk`.
// Never with a separator between nearly every digit, though: a number written a digit at a time is a list of numbers
// (a shell loop's `for i in 1 2 3 …`), not a phone or an account written out (`digitByDigit`).
export type Spelling = "exact" | "case" | "folded";

export interface KnownValue<C> {
    readonly value: string;
    readonly payload: C;
    // Absent: exact.
    readonly spelling?: Spelling;
}

export interface KnownMatch<C> {
    readonly start: number;
    readonly end: number;
    readonly payload: C;
}

export interface KnownMatcher<C> {
    readonly find: (text: string) => KnownMatch<C>[];
    readonly size: number;
}

const WORD = /[\p{L}\p{N}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
// What a folded spelling may write between, or leave out of, the characters that count.
const FOLD = /[\s_-]/u;
// How many characters of a value, as compared, its index entry holds.
const PREFIX = 3;

const isWordChar = (char: string | undefined): boolean => char !== undefined && WORD_CHAR.test(char);

// One character as a spelling compares it.
const unitOf = (char: string, spelling: Spelling): string => (spelling === "exact" ? char : char.toLowerCase());

interface Spelled {
    // What stands before the value's first word (`+` of `+48 600…`), as compared.
    readonly lead: string;
    // Every character from the first word on, as compared; a folded spelling's separators left out.
    readonly units: readonly string[];
}

const spelled = (value: string, spelling: Spelling): Spelled | undefined => {
    const first = /[\p{L}\p{N}]/u.exec(value);
    if (first === null) {
        return undefined;
    }
    const units = Array.from(value.slice(first.index)).filter((char) => spelling !== "folded" || !FOLD.test(char)).map((char) => unitOf(char, spelling));
    return { lead: Array.from(value.slice(0, first.index)).map((char) => unitOf(char, spelling)).join(""), units };
};

// The one key every spelling of a value shares: two values with the same key are the same value.
export const spellingKey = (value: string, spelling: Spelling): string => {
    const parts = spelled(value, spelling);
    return parts === undefined ? `${spelling}:${value}` : `${spelling}:${parts.lead}\u0000${parts.units.join("")}`;
};

interface Candidate<C> extends Spelled {
    readonly spelling: Spelling;
    readonly payload: C;
}

// Where `candidate` ends if it is written at `at` (its first word's first character), else undefined.
const endAt = <C>(text: string, at: number, candidate: Candidate<C>): number | undefined => {
    let position = at;
    for (const [index, unit] of candidate.units.entries()) {
        if (candidate.spelling === "folded" && index > 0) {
            while (position < text.length && FOLD.test(text.charAt(position))) {
                position += 1;
            }
        }
        const char = String.fromCodePoint(text.codePointAt(position) ?? 0);
        if (position >= text.length || unitOf(char, candidate.spelling) !== unit) {
            return undefined;
        }
        position += char.length;
    }
    return position;
};

// Whole-word on each side the value itself is a word on: `Ala` is not found inside `Alabama`, and a PESEL not inside a
// longer number, while a value that ends in punctuation needs nothing after it. The letter of a JSON escape before it
// (`\n` in raw JSON text) is the escape's, not a word's.
// Nor where a digit at its edge continues a decimal: a float's places once found as a card number (`0.55899…99`) are a
// float's wherever they come back. A decimal point only, as the card detector reads it (@intentic/privacy-detect text.ts partOfDecimal).
const boundedAt = <C>(text: string, start: number, end: number, candidate: Candidate<C>): boolean => {
    const before = candidate.lead === "" && isWordChar(text[start - 1]) && !afterEscape(text, start);
    const after = isWordChar(candidate.units.at(-1)) && isWordChar(text[end]);
    const fractionBefore = candidate.lead === "" && isDigit(candidate.units[0]) && text[start - 1] === "." && isDigit(text[start - 2]);
    const fractionAfter = isDigit(candidate.units.at(-1)) && text[end] === "." && isDigit(text[end + 1]);
    return !before && !after && !fractionBefore && !fractionAfter;
};

// A number a folded spelling matched with two lone digits or more, each standing between separators: no number is
// grouped like that, while one lone digit is a country code (`+1 …`) or a trunk zero (`0 22 …`). Numbers only: an
// address's house and flat numbers stand alone as a matter of course (`Długa 5 m 3`).
const NUMBER_SPELLED = /^[\p{N}\s_-]+$/u;
const LONE_DIGITS = /(?:^|[\s_-])\p{N}(?=[\s_-]|$)/gu;
const digitByDigit = (matched: string): boolean => NUMBER_SPELLED.test(matched) && (matched.match(LONE_DIGITS) ?? []).length >= 2;

// The places a value can start in a text: each word's first character, and the character after an escape's letter.
const wordStarts = (text: string): number[] =>
    [...text.matchAll(WORD)].flatMap((word) => (word[0].length > 1 && afterEscape(text, word.index + 1) ? [word.index, word.index + 1] : [word.index]));

// The first characters of the text at `at` as each spelling compares them, as far as an index key reaches.
const prefixesAt = (text: string, at: number, spelling: Spelling): string[] => {
    const units: string[] = [];
    let position = at;
    while (units.length < PREFIX && position < text.length) {
        const char = String.fromCodePoint(text.codePointAt(position) ?? 0);
        position += char.length;
        if (spelling === "folded" && units.length > 0 && FOLD.test(char)) {
            continue;
        }
        units.push(unitOf(char, spelling));
    }
    return units.map((_, index) => `${spelling}:${units.slice(0, index + 1).join("")}`);
};

const SPELLINGS: readonly Spelling[] = ["exact", "case", "folded"];

export const createKnownMatcher = <C>(values: readonly KnownValue<C>[]): KnownMatcher<C> => {
    const byPrefix = new Map<string, Candidate<C>[]>();
    for (const { value, payload, spelling = "exact" } of values) {
        const parts = spelled(value, spelling);
        if (parts === undefined) {
            continue;
        }
        const key = `${spelling}:${parts.units.slice(0, PREFIX).join("")}`;
        const list = byPrefix.get(key) ?? [];
        list.push({ ...parts, spelling, payload });
        byPrefix.set(key, list);
    }
    const length = (candidate: Candidate<C>): number => candidate.lead.length + candidate.units.length;
    return {
        size: values.length,
        find: (text) => {
            if (byPrefix.size === 0) {
                return [];
            }
            const found: KnownMatch<C>[] = [];
            let covered = 0;
            for (const at of wordStarts(text)) {
                // Longest first, so a full name wins over the first name it starts with.
                const candidates = SPELLINGS.flatMap((spelling) => prefixesAt(text, at, spelling).flatMap((key) => byPrefix.get(key) ?? [])).toSorted(
                    (left, right) => length(right) - length(left),
                );
                for (const candidate of candidates) {
                    const start = at - candidate.lead.length;
                    if (start < covered || Array.from(text.slice(start, at)).map((char) => unitOf(char, candidate.spelling)).join("") !== candidate.lead) {
                        continue;
                    }
                    const end = endAt(text, at, candidate);
                    if (
                        end === undefined ||
                        !boundedAt(text, start, end, candidate) ||
                        (candidate.spelling === "folded" && digitByDigit(text.slice(at, end)))
                    ) {
                        continue;
                    }
                    found.push({ start, end, payload: candidate.payload });
                    covered = end;
                    break;
                }
            }
            return found;
        },
    };
};
