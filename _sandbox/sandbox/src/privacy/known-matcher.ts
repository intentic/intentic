import { afterEscape } from "@intentic/privacy-detect/text";
import { NONE, UnitTrie } from "./known-trie.js";

// Finds every value the vault already holds, wherever it stands as a whole word, in each spelling its kind allows
// (`Spelling`). A value can only start at a word start, so each spelling's values sit in one trie over their units as
// compared, and the text is walked from each word start only as far as some value still agrees with it.
//
// 2026-11-24: replaced an index of each value's first 3 units, which tried every value in that bucket at every word
// start (names share prefixes: `Ann`, `Mar`, `Jan`), and was rebuilt whole by the vault for every new token. Measured
// with 30k vault values: 120 KB of text with no hits 48 → 9 ms, 200 KB with many 213 → 22 ms; 6k values sharing a
// prefix over 100 KB 7.2 s → 7 ms. Building costs about twice the index (63 ms against 31 ms at 30k), paid once: `add`.
// Matching is unchanged: every match, its span and the order `accept` is asked in (checked against the index on
// randomized texts and vaults).

// How a value may be written and still be that value. `exact`: as written (one plain word, where case is what tells
// `Mark` from `mark`). `case`: in any case (an e-mail address, whose dots and dashes are its own). `folded`: in any
// case, with its spaces, line breaks, hyphens and underscores anywhere or nowhere (a full name, a document or account
// number): `Jan Kowalski`, `JAN  KOWALSKI`, `jan_kowalski`, `JanKowalski`, `ACME-0042-XK`, `acme0042xk`.
// Whether a spelling found is the value where it stands (not a decimal's places, not a list of digits) is the
// caller's to say (`find`'s `accept`): the matcher knows strings, not kinds.
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
    // `accept` turns a match down where it stands, and the next shorter value at that place is tried instead.
    readonly find: (text: string, accept?: (start: number, end: number, payload: C) => boolean) => KnownMatch<C>[];
    // Matches these too from now on, as if they had been passed last to createKnownMatcher: a vault handing out one new
    // token does not rebuild the whole trie.
    readonly add: (values: readonly KnownValue<C>[]) => void;
    readonly size: number;
}

const WORD = /[\p{L}\p{N}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
// What a folded spelling may write between, or leave out of, the characters that count.
const FOLD = /[\s_-]/u;
// How many units of a value the index replaced on 2026-11-24 was keyed by. Still the second key values of equal length
// are tried in (`order`), so `accept` is asked in exactly the order it was.
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
    const units = Array.from(value.slice(first.index))
        .filter((char) => spelling !== "folded" || !FOLD.test(char))
        .map((char) => unitOf(char, spelling));
    return {
        lead: Array.from(value.slice(0, first.index))
            .map((char) => unitOf(char, spelling))
            .join(""),
        units,
    };
};

// The one key every spelling of a value shares: two values with the same key are the same value.
export const spellingKey = (value: string, spelling: Spelling): string => {
    const parts = spelled(value, spelling);
    return parts === undefined ? `${spelling}:${value}` : `${spelling}:${parts.lead}\u0000${parts.units.join("")}`;
};

interface Candidate<C> {
    // What stands before the value's first word, as compared (Spelled `lead`).
    readonly lead: string;
    readonly payload: C;
    // The value ends in a character of a word, so a word character after it means it is part of a longer word.
    readonly endsInWord: boolean;
    // The order values are tried in where several match at one place: longest first (lead's UTF-16 length plus the
    // number of units, as the prefix index measured it), then spelling (SPELLINGS), then how many units its prefix-index
    // key held, then the order the values were given in. The index replaced on 2026-11-24 tried them in this order, and
    // `accept` must still be asked about them in it.
    readonly order: readonly [number, number, number, number];
}

const SPELLINGS: readonly Spelling[] = ["exact", "case", "folded"];

const byTryOrder = <C>(left: { readonly candidate: Candidate<C> }, right: { readonly candidate: Candidate<C> }): number => {
    const [a, b] = [left.candidate.order, right.candidate.order];
    return b[0] - a[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
};

// Whole-word on each side the value itself is a word on: `Ala` is not found inside `Alabama`, and a PESEL not inside a
// longer number, while a value that ends in punctuation needs nothing after it. The letter of a JSON escape before it
// (`\n` in raw JSON text) is the escape's, not a word's.
const boundedAt = <C>(text: string, start: number, end: number, candidate: Candidate<C>): boolean => {
    const before = candidate.lead === "" && isWordChar(text[start - 1]) && !afterEscape(text, start);
    const after = candidate.endsInWord && isWordChar(text[end]);
    return !before && !after;
};

// The places a value can start in a text: each word's first character, and the character after an escape's letter.
const wordStarts = (text: string): number[] =>
    [...text.matchAll(WORD)].flatMap((word) =>
        word[0].length > 1 && afterEscape(text, word.index + 1) ? [word.index, word.index + 1] : [word.index],
    );

// Whether an ASCII character is one a folded spelling skips (FOLD), by its code.
const ASCII_FOLD = Array.from({ length: 128 }, (_, code) => FOLD.test(String.fromCharCode(code)));
const skipped = (text: string, position: number): boolean => {
    const code = text.charCodeAt(position);
    return code < ASCII_FOLD.length ? ASCII_FOLD[code]! : FOLD.test(text.charAt(position));
};

// Where a folded spelling's next unit stands from `position`: past any separators. Other spellings skip nothing.
const nextUnitAt = (text: string, position: number, spelling: Spelling): number => {
    if (spelling !== "folded") {
        return position;
    }
    let at = position;
    while (at < text.length && skipped(text, at)) {
        at += 1;
    }
    return at;
};

// Whether what stands before `at` is the candidate's lead, as its spelling compares it.
const leadAt = <C>(text: string, start: number, at: number, candidate: Candidate<C>): boolean =>
    candidate.lead === "" ||
    Array.from(text.slice(start, at))
        .map((char) => unitOf(char, SPELLINGS[candidate.order[1]]!))
        .join("") === candidate.lead;

interface Reached<C> {
    readonly candidate: Candidate<C>;
    readonly end: number;
}

// The values a spelling holds, as one trie with a root of its own per spelling, and the values that end at each node.
interface Vocabulary<C> {
    readonly trie: UnitTrie;
    readonly ending: Map<number, Candidate<C>[]>;
    // Each spelling's root, once it holds a value, in SPELLINGS order.
    readonly roots: { readonly spelling: Spelling; readonly node: number }[];
}

const rootOf = <C>({ trie, roots }: Vocabulary<C>, spelling: Spelling): number => {
    const existing = roots.find((root) => root.spelling === spelling);
    if (existing !== undefined) {
        return existing.node;
    }
    const node = trie.newNode();
    roots.push({ spelling, node });
    roots.sort((left, right) => SPELLINGS.indexOf(left.spelling) - SPELLINGS.indexOf(right.spelling));
    return node;
};

// Adds a value as the `added`th given; false for one with no word in it, which is never matched.
const insert = <C>(vocabulary: Vocabulary<C>, { value, payload, spelling = "exact" }: KnownValue<C>, added: number): boolean => {
    const parts = spelled(value, spelling);
    if (parts === undefined) {
        return false;
    }
    const node = vocabulary.trie.insert(rootOf(vocabulary, spelling), parts.units);
    const list = vocabulary.ending.get(node) ?? [];
    list.push({
        lead: parts.lead,
        payload,
        endsInWord: isWordChar(parts.units.at(-1)),
        order: [parts.lead.length + parts.units.length, SPELLINGS.indexOf(spelling), Math.min(PREFIX, parts.units.length), added],
    });
    vocabulary.ending.set(node, list);
    return true;
};

// Every value of a spelling written at `at` (its first word's first character), and where each ends: the trie walked as
// the text goes, a folded spelling's separators skipped between units, until no value agrees with the text. Each
// character is compared as one code point, as `unitOf` compares it.
const reachedFrom = <C>({ trie, ending }: Vocabulary<C>, text: string, at: number, spelling: Spelling, root: number, out: Reached<C>[]): void => {
    let node = root;
    let position = at;
    while (position < text.length) {
        const code = text.codePointAt(position) ?? 0;
        const unit = trie.unitOf(code, spelling === "exact", () => unitOf(String.fromCodePoint(code), spelling));
        node = unit === NONE ? NONE : trie.child(node, unit);
        if (node === NONE) {
            return;
        }
        position += code > 0xffff ? 2 : 1;
        for (const candidate of ending.get(node) ?? []) {
            out.push({ candidate, end: position });
        }
        position = nextUnitAt(text, position, spelling);
    }
};

export const createKnownMatcher = <C>(values: readonly KnownValue<C>[]): KnownMatcher<C> => {
    const vocabulary: Vocabulary<C> = { trie: new UnitTrie(), ending: new Map(), roots: [] };
    let size = 0;
    let added = 0;
    const add = (more: readonly KnownValue<C>[]): void => {
        for (const value of more) {
            added += insert(vocabulary, value, added) ? 1 : 0;
        }
        size += more.length;
    };
    add(values);

    // The first value written at `at`, longest first so a full name wins over the first name it starts with, that stands
    // clear of what was matched already, as a whole word, and that `accept` takes.
    const firstAt = (text: string, at: number, covered: number, accept: (start: number, end: number, payload: C) => boolean) => {
        const here: Reached<C>[] = [];
        for (const root of vocabulary.roots) {
            reachedFrom(vocabulary, text, at, root.spelling, root.node, here);
        }
        here.sort(byTryOrder);
        return here.find(({ candidate, end }) => {
            const start = at - candidate.lead.length;
            return start >= covered && leadAt(text, start, at, candidate) && boundedAt(text, start, end, candidate) && accept(start, end, candidate.payload);
        });
    };

    return {
        get size() {
            return size;
        },
        add,
        find: (text, accept = () => true) => {
            const found: KnownMatch<C>[] = [];
            if (vocabulary.ending.size === 0) {
                return found;
            }
            let covered = 0;
            for (const at of wordStarts(text)) {
                const match = at < covered ? undefined : firstAt(text, at, covered, accept);
                if (match !== undefined) {
                    found.push({ start: at - match.candidate.lead.length, end: match.end, payload: match.candidate.payload });
                    covered = match.end;
                }
            }
            return found;
        },
    };
};
