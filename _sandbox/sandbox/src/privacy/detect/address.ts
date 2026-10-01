import type { Emit } from "./text.js";

// Polish postal addresses, conservatively: a street marker with a capitalized street name and a house number
// ("ul. Marszałkowskiej 12/4 m. 5, 00-001 Warszawa"), or a postal code with the place it belongs to ("00-001
// Warszawa"). A street named without a number is a place anyone may mention, not where someone lives.

const STREET_MARKER =
    /(?<![\p{L}\p{N}_.])(?:ul\.|ulica|ulicy|ulicę|ulicą|al\.|aleja|alei|aleję|aleje|alejach|pl\.|plac|placu|placem|os\.|osiedle|osiedlu|osiedla)(?=[\s\p{Lu}])/giu;
// "et al." ends a citation; what follows it is not a street.
const ET_AL = /\bet\s$/i;
const SPACES = / {1,3}/y;
const ONE_SPACE = / /y;
// A street's name: capitalized words, the abbreviated ranks and titles streets are named with, a leading day number
// ("3 Maja", "11 Listopada") and a trailing regnal number ("Jana Pawła II").
const STREET_WORD = /\p{Lu}\p{Ll}+(?:-\p{Lu}?\p{Ll}+)*(?![\p{L}\p{N}])/uy;
const STREET_ABBREVIATION = /(?:gen|ks|św|bp|abp|kard|marsz|prof|dr|płk|kpt|mjr|hetm|kr|bł|o|ppłk|por|inż|im)\.(?= )/uy;
const DAY_NUMBER = /\d{1,2}(?= \p{Lu})/uy;
const ROMAN = /[IVX]{1,4}(?![\p{L}\p{N}])/uy;
const HOUSE_NUMBER =
    /\d{1,4}[a-zA-Z]?(?:-\d{1,4}[a-zA-Z]?)?(?: ?\/ ?\d{1,4}[a-zA-Z]?)?(?:,? ?(?:m\.|lok\.|lokal|m) ?\d{1,4}[a-zA-Z]?)?(?![\p{L}\p{N}/])/uy;
const POSTAL_AFTER_STREET = /,? {1,2}(\d{2}-\d{3}) {1,2}/uy;
const POSTAL = /(?<![\p{L}\p{N}_-])\d{2}-\d{3}(?![\p{N}-])/gu;
const PLACE_WORD = /\p{Lu}(?:\p{Ll}+|\p{Lu}{3,})(?:-\p{Lu}(?:\p{Ll}+|\p{Lu}+))*(?![\p{L}\p{N}])/uy;
const VOWEL = /[aeiouyąęóAEIOUYĄĘÓ]/u;
// English plurals ("10-100 Users") follow a range that looks like a postal code; Polish place names do not end so.
const ENGLISH_PLURAL = /^[A-Za-z]+[^s]s$/;
const STREET_AFTER_PLACE = /^,? (?:ul\.|al\.|pl\.|os\.)/iu;

const matchAt = (pattern: RegExp, text: string, index: number): RegExpExecArray | null => {
    pattern.lastIndex = index;
    return pattern.exec(text);
};

// The place after a postal code: up to three capitalized words ("Zielona Góra", "Bielsko-Biała", "WARSZAWA"). Returns
// where it ends, or undefined when what follows is not a place.
const placeEnd = (text: string, index: number): number | undefined => {
    let end: number | undefined;
    let cursor = index;
    for (let words = 0; words < 3; words += 1) {
        const word = matchAt(PLACE_WORD, text, cursor);
        if (word === null || (words === 0 && (word[0].length < 3 || !VOWEL.test(word[0]) || ENGLISH_PLURAL.test(word[0])))) {
            break;
        }
        end = cursor + word[0].length;
        if (text[end] !== " ") {
            break;
        }
        cursor = end + 1;
    }
    return end;
};

// Where a street name and its house number end, starting right after the marker; undefined when they are not there.
const streetEnd = (text: string, index: number): number | undefined => {
    let cursor = index;
    const lead = matchAt(SPACES, text, cursor);
    if (lead !== null) {
        cursor += lead[0].length;
    }
    let words = 0;
    for (let items = 0; items < 8; items += 1) {
        const at = items === 0 ? cursor : cursor + 1;
        if (items > 0 && matchAt(ONE_SPACE, text, cursor) === null) {
            break;
        }
        const word = matchAt(STREET_WORD, text, at);
        const item =
            word ??
            matchAt(STREET_ABBREVIATION, text, at) ??
            (items === 0 ? matchAt(DAY_NUMBER, text, at) : null) ??
            (words > 0 ? matchAt(ROMAN, text, at) : null);
        // Not part of the name: this is where the house number should be.
        if (item === null) {
            break;
        }
        words += word === null ? 0 : 1;
        cursor = at + item[0].length;
    }
    if (words === 0 || matchAt(ONE_SPACE, text, cursor) === null) {
        return undefined;
    }
    const house = matchAt(HOUSE_NUMBER, text, cursor + 1);
    return house === null ? undefined : cursor + 1 + house[0].length;
};

export const findAddresses = (text: string, emit: Emit): void => {
    for (const marker of text.matchAll(STREET_MARKER)) {
        const start = marker.index;
        if (marker[0].toLowerCase() === "al." && ET_AL.test(text.slice(Math.max(0, start - 3), start))) {
            continue;
        }
        let end = streetEnd(text, start + marker[0].length);
        if (end === undefined) {
            continue;
        }
        const postal = matchAt(POSTAL_AFTER_STREET, text, end);
        const place = postal === null ? undefined : placeEnd(text, end + postal[0].length);
        end = place ?? end;
        emit(start, end, "address");
    }
    for (const postal of text.matchAll(POSTAL)) {
        let cursor = postal.index + postal[0].length;
        const gap = matchAt(SPACES, text, cursor);
        if (gap === null || gap[0].length > 2) {
            continue;
        }
        cursor += gap[0].length;
        const end = placeEnd(text, cursor);
        if (end === undefined) {
            continue;
        }
        // A place ends its clause; "10-100 Users per seat" goes on in lowercase.
        const after = text.slice(end, end + 6);
        if (/^ \p{Ll}/u.test(after) && !STREET_AFTER_PLACE.test(after)) {
            continue;
        }
        emit(postal.index, end, "address");
    }
};
