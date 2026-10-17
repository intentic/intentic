import { open } from "node:fs/promises";
import { mapPool } from "@intentic/base/async";
import { escapeRegExp } from "@intentic/base/escape";
import { refuse } from "@intentic/contract-serve";
import type { WorkspaceSearchHit } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { type Cut, type Found, MAX_PER_FILE, MAX_TEXT_BYTES, byMatches, groupOf, hitOf } from "./search-hits.js";
import type { SweptFile } from "./sweep.js";

// A folder's search read here, file by file: what answers when this computer has no ripgrep to run (search.ts). Lines
// match by a JavaScript pattern, so a pattern is refused before anything is read when it could backtrack without end;
// the clock is read between files and between lines, so no file holds the search past its budget by more than one
// line's work.

// One file's first 8 KiB holding a NUL is not text at all.
const SNIFF_BYTES = 8 * 1024;
// Files read at once.
const READ_POOL = 8;

export const NOT_A_PATTERN = `The query isn't a pattern this search reads, so it was searched as plain text.`;
const TOO_SLOW = `This pattern could take too long to search. Simplify it, or search for the text as typed.`;

// A quantifier at `at`: `*`, `+`, or a count such as `{2}` or `{2,}` (a `?` never repeats, so it cannot compound).
const quantifierAt = (source: string, at: number): boolean =>
    source[at] === `*` || source[at] === `+` || (source[at] === `{` && /^\{\d+(?:,\d*)?\}/.test(source.slice(at)));

// Whether a pattern repeats a group that itself repeats something (`(a+)+`, `(\w*\s?)*`, `(x{2,})+`): the nested
// quantifier whose failure to match backtracks exponentially, so that one line of text can hold the whole process for
// minutes. Read the way the engine reads it: an escape is one character, and nothing inside a class is a quantifier.
export const nestsQuantifiers = (source: string): boolean => {
    // Per group still open, innermost last, whether anything inside it repeats.
    const repeating: boolean[] = [];
    let inClass = false;
    for (let at = 0; at < source.length; at++) {
        const char = source[at];
        if (char === `\\`) {
            at++;
        } else if (inClass) {
            inClass = char !== `]`;
        } else if (char === `[`) {
            inClass = true;
        } else if (char === `(`) {
            repeating.push(false);
        } else if (char === `)`) {
            const repeatsInside = repeating.pop() === true;
            if (repeatsInside && quantifierAt(source, at + 1)) {
                return true;
            }
            if (repeating.length > 0 && (repeatsInside || quantifierAt(source, at + 1))) {
                repeating[repeating.length - 1] = true;
            }
        } else if (repeating.length > 0 && quantifierAt(source, at)) {
            repeating[repeating.length - 1] = true;
        }
    }
    return false;
};

// A whole word: no letter, digit or underscore on either side, in any script where the pattern allows saying so.
const bounded = (body: string, unicode: boolean): string =>
    unicode ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : `(?<![A-Za-z0-9_])(?:${body})(?![A-Za-z0-9_])`;

export interface Matcher {
    readonly regex: RegExp;
    readonly note?: string;
}

export interface Pattern {
    readonly query: string;
    readonly literal?: boolean | undefined;
    readonly word?: boolean | undefined;
    readonly caseSensitive?: boolean | undefined;
}

const compiled = (source: string, word: boolean, flags: string): RegExp | undefined => {
    for (const unicode of [true, false]) {
        try {
            return new RegExp(word ? bounded(source, unicode) : source, `${flags}${unicode ? `u` : ``}`);
        } catch {
            // allow(silent-catch): a pattern the engine refuses is tried without Unicode mode, then read as plain text.
            continue;
        }
    }
    return undefined;
};

// The query as a pattern, as the search box means it: a pattern unless `literal`, any case unless `caseSensitive`. A
// pattern that could backtrack without end is refused before anything is read, rather than left to hold the process.
export const matcherOf = (search: Pattern): Matcher => {
    const flags = search.caseSensitive === true ? `g` : `gi`;
    const word = search.word === true;
    const regex = search.literal === true ? undefined : compiled(search.query, word, flags);
    if (regex !== undefined) {
        return nestsQuantifiers(search.query) ? refuse(TOO_SLOW, 400) : { regex };
    }
    const plain = compiled(escapeRegExp(search.query), word, flags) ?? new RegExp(escapeRegExp(search.query), flags);
    return search.literal === true ? { regex: plain } : { regex: plain, note: NOT_A_PATTERN };
};

// A file's text, or undefined for one that is not text a person searches: too large, binary, or unreadable.
const textOf = async (abs: string): Promise<string | undefined> => {
    let handle;
    try {
        handle = await open(abs, `r`);
        const found = await handle.stat();
        if (!found.isFile() || found.size > MAX_TEXT_BYTES) {
            return undefined;
        }
        const bytes = await handle.readFile();
        return bytes.subarray(0, SNIFF_BYTES).includes(0) ? undefined : bytes.toString(`utf8`);
    } catch {
        // allow(silent-catch): a file that cannot be read is one there is nothing in to find.
        return undefined;
    } finally {
        await handle?.close();
    }
};

// One file's matching lines as far as they were read, and whether the clock stopped the reading.
interface Matched {
    readonly hits: WorkspaceSearchHit[];
    readonly capped: boolean;
    readonly cut: boolean;
}

// The lines of one file the pattern matches, up to the per-file cap, with every match's character span. The clock is
// read before each line, so a long file stops where the budget runs out rather than where the file does.
const matchedIn = (text: string, regex: RegExp, over: () => boolean): Matched => {
    const hits: WorkspaceSearchHit[] = [];
    for (const [index, raw] of text.split(`\n`).entries()) {
        if (over()) {
            return { hits, capped: false, cut: true };
        }
        const line = raw.endsWith(`\r`) ? raw.slice(0, -1) : raw;
        const matches = [...line.matchAll(regex)];
        if (matches.length === 0) {
            continue;
        }
        if (hits.length === MAX_PER_FILE) {
            return { hits, capped: true, cut: false };
        }
        const spans = matches.filter((match) => match[0].length > 0).map((match) => ({ start: match.index, end: match.index + match[0].length }));
        hits.push(hitOf(index + 1, line, spans));
    }
    return { hits, capped: false, cut: false };
};

// Every file's matching lines, read a few at a time until the files, the hit cap or the clock run out.
export const findHere = async (files: readonly SweptFile[], regex: RegExp, maxHits: number, over: () => boolean): Promise<Found> => {
    const found: Found[`groups`][number][] = [];
    let hits = 0;
    let cut: Cut | undefined;
    await mapPool(files, READ_POOL, async (file) => {
        if (cut !== undefined) {
            return;
        }
        if (hits >= maxHits || over()) {
            cut = hits >= maxHits ? `matches` : `time`;
            return;
        }
        const text = await textOf(file.abs);
        const matched = text === undefined ? undefined : matchedIn(text, regex, over);
        if (matched?.cut === true) {
            cut = `time`;
        }
        const group = matched === undefined ? undefined : groupOf(file.path, matched.hits, matched.capped);
        if (group !== undefined) {
            found.push(group);
            hits += group.hits.length;
            if (hits >= maxHits) {
                cut ??= `matches`;
            }
        }
    });
    return { groups: found.toSorted(byMatches), cut };
};
