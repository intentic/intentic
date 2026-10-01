import type { PersonalDataClass } from "@intentic/sandbox-contract";

// What every detector reports a find through: offsets into the text it was handed, end exclusive.
export type Emit = (start: number, end: number, kind: PersonalDataClass) => void;

const WORD = /[\p{L}\p{N}_]/u;
const LETTER = /\p{L}/u;

// Character tests take `undefined` because they are mostly asked about the character before the start or after the
// end of a match, which may be past either end of the text.
export const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";
export const isLetter = (ch: string | undefined): boolean => ch !== undefined && LETTER.test(ch);
export const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD.test(ch);

// A digit run that continues a decimal number ("3.85010112345", "85010112345,5") is a measurement, not an identifier.
export const partOfNumber = (text: string, start: number, end: number): boolean => {
    const before = text[start - 1];
    if ((before === "." || before === ",") && isDigit(text[start - 2])) {
        return true;
    }
    const after = text[end];
    return (after === "." || after === ",") && isDigit(text[end + 1]);
};

// Whether a keyword (a non-global pattern) appears in the few characters before a match: "NIP: 1234567890",
// "tel. 600100200". Bare digit runs are too common to report without one.
export const keywordBefore = (text: string, start: number, keyword: RegExp, window = 25): boolean =>
    keyword.test(text.slice(Math.max(0, start - window), start));

// The digits of a match written with separators, for checksums.
export const digitsOf = (value: string): string => value.replace(/\D/g, "");
