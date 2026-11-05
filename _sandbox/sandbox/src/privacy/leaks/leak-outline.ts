import { leakWordsOf, PRIVACY_LEAK_CONTEXT_REACH, type PrivacyLeakWordFacts } from "@intentic/sandbox-contract/schemas/privacy-leaks";
import type { Lexicon } from "@intentic/privacy-detect/lexicon";

// What a hardening session on a provider nobody trusted may read of a leak, in place of the value and the text around
// it (schemas/privacy-leaks.ts): the value's outline, the label of the field it stood under, and what the name lists say
// of each of its words. Enough to write a pattern anchored on a label, or to see that a surname is also a word; never
// a character of the value itself.

const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const DIGIT = /\p{N}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// Each capital as A, each small letter as a, each digit as 9; a letter without case (CJK) as X; anything else as it is.
export const outlineOf = (value: string): string =>
    [...value]
        .map((char) => {
            if (UPPER.test(char)) {
                return "A";
            }
            if (LOWER.test(char)) {
                return "a";
            }
            if (DIGIT.test(char)) {
                return "9";
            }
            return LETTER_OR_DIGIT.test(char) ? "X" : char;
        })
        .join("");

// What the lists say of each word of a value, in order: what a list proposal names by position.
export const wordFactsOf = (value: string, lexicon: Lexicon): PrivacyLeakWordFacts[] =>
    leakWordsOf(value).map((word) => {
        const info = lexicon.info(word);
        return {
            outline: outlineOf(word),
            firstName: info.first,
            surname: info.surname,
            surnameForm: info.surnameForm,
            ambiguous: info.ambiguous,
            never: info.never,
        };
    });

// Markdown emphasis and table bars around a label, which say nothing of what it labels.
const DECORATION = /[*_`#>]+/gu;
const LABEL_WORDS = 4;

// A word of a label as an untrusted reader may read it: as written when it holds no digit and the name lists know it
// as no name (a field's own words, "Nr", "paszportu", "E-mail"); as its outline when it could be somebody's.
const labelWord = (word: string, lexicon: Lexicon): string => {
    if (DIGIT.test(word)) {
        return outlineOf(word);
    }
    const info = lexicon.info(word.replace(/[^\p{L}-]/gu, ""));
    const couldBeName = (info.first || info.surname || info.surnameForm) && !info.never;
    return couldBeName ? outlineOf(word) : word;
};

// The label just before the value at `at` in `text`: up to four words on its line, or in the table cell before its own
// when the value starts a cell (`| Nr paszportu | AB8100000 |`). Undefined when nothing labels it.
export const labelBefore = (text: string, at: number, lexicon: Lexicon): string | undefined => {
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    let before = text.slice(lineStart, at);
    // The value opens a cell: the label is the cell before it.
    const cells = before.split("|");
    if (cells.length > 1 && (cells.at(-1) ?? "").trim() === "") {
        before = cells.at(-2) ?? "";
    }
    const words = before
        .replace(DECORATION, " ")
        .replace(/[:=|\t]+\s*$/u, "")
        .split(/\s+/u)
        .filter((word) => LETTER_OR_DIGIT.test(word));
    if (words.length === 0) {
        return undefined;
    }
    return words
        .slice(-LABEL_WORDS)
        .map((word) => labelWord(word, lexicon))
        .join(" ");
};

// Where a leak's value sits in the text around it: the occurrence nearest the middle, since the stretch kept around a
// value centres on it; undefined when the text does not hold it.
export const valueAt = (context: string, value: string): number | undefined => {
    let best: number | undefined;
    const middle = context.length / 2;
    for (let at = context.indexOf(value); at !== -1; at = context.indexOf(value, at + 1)) {
        if (best === undefined || Math.abs(at + value.length / 2 - middle) < Math.abs(best + value.length / 2 - middle)) {
            best = at;
        }
    }
    return best;
};

// The stretch of `text` kept around a value at `at`: its reach on each side, cut at whitespace where there is some
// within reach so neither end splits a word.
export const contextAround = (text: string, at: number, length: number, reach = PRIVACY_LEAK_CONTEXT_REACH): string => {
    let from = Math.max(0, at - reach);
    let to = Math.min(text.length, at + length + reach);
    if (from > 0) {
        const space = text.slice(from, at).search(/\s/u);
        from = space === -1 ? from : from + space + 1;
    }
    if (to < text.length) {
        const tail = text.slice(at + length, to);
        const space = Math.max(tail.lastIndexOf(" "), tail.lastIndexOf("\n"));
        to = space === -1 ? to : at + length + space;
    }
    return text.slice(from, to);
};
